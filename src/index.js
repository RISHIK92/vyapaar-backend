import express from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import { uploadFileToS3 } from "./utils/upload.js";
import authenticateToken from "./middleware/auth.js";
import multer from "multer";
import paymentRoutes from "./routes/payment.js";
import locationRoutes from "./routes/location.js";
import NodeCache from "node-cache";
import axios from "axios";
import getFilteredMiddleBanners, {
  formatMiddleBanners,
} from "./utils/middleBanner.js";
import getFilteredBottomBanners, {
  formatBottomBanners,
} from "./utils/bottomBanner.js";
import getFilteredHeroBanners, {
  formatHeroBanners,
} from "./utils/heroBanner.js";
import getFilteredCategoryBanners, {
  formatCategoryBanners,
} from "./utils/categoryBanner.js";

const pincodeCache = new NodeCache({ stdTTL: 86400 });

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const calculateExpirationDate = (durationDays) => {
  const date = new Date();
  date.setDate(date.getDate() + durationDays);
  return date;
};

app.use("/payments", paymentRoutes);
app.use("/location", locationRoutes);

// Auth Endpoints
app.post("/register", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      city,
      password,
      confirmPassword,
    } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      return res
        .status(400)
        .json({ message: "User already exists with this email" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        phone,
        city,
      },
    });

    const token = jwt.sign({ userId: newUser.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.sameSite,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const { password: _, ...userData } = newUser;
    res.status(201).json({
      message: "User registered successfully",
      user: userData,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.sameSite,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const { password: _, ...userData } = user;
    res.status(200).json({
      message: "Login successful",
      user: userData,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error during login" });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.sameSite,
  });
  res.status(200).json({ message: "Logged out successfully" });
});

app.get("/check-auth", authenticateToken, (req, res) => {
  res.status(200).json({ isAuthenticated: true, user: req.user });
});

// Profile Endpoints
app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        city: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ message: "Error fetching profile" });
  }
});

app.put("/profile", authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone, city } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        firstName,
        lastName,
        phone,
        city,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        city: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: "Error updating profile" });
  }
});

app.put("/profile/password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    const passwordValid = await bcrypt.compare(currentPassword, user.password);
    if (!passwordValid) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: req.user.userId },
      data: { password: hashedPassword },
    });

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password change error:", error);
    res.status(500).json({ message: "Error changing password" });
  }
});

app.delete("/profile", authenticateToken, async (req, res) => {
  try {
    await prisma.user.delete({
      where: { id: req.user.userId },
    });

    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.sameSite,
    });

    res.json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ message: "Error deleting account" });
  }
});

app.get("/listings", authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      where: {
        userId: req.user.userId,
        status: "APPROVED",
      },
      include: {
        category: true,
        images: true,
        city: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(listings);
  } catch (error) {
    console.error("Listings error:", error);
    res.status(500).json({ message: "Error fetching listings" });
  }
});

app.get("/list/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    // Validate slug parameter
    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ message: "Invalid listing slug" });
    }

    const listing = await prisma.listing.findFirst({
      where: {
        slug: slug,
        status: "APPROVED",
      },
      include: {
        category: true,
        images: {
          orderBy: {
            isPrimary: "desc", // Show primary image first
          },
        },
        city: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            city: true,
            createdAt: true,
          },
        },
        reviews: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        promotions: {
          where: {
            isActive: true,
            OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
        subscription: {
          select: {
            name: true,
            tierType: true,
          },
        },
      },
    });

    if (!listing) {
      return res
        .status(404)
        .json({ message: "Listing not found or not approved" });
    }

    const similarListings = await prisma.listing.findMany({
      where: {
        AND: [
          {
            status: "APPROVED",
            NOT: { id: listing.id },
          },
          {
            OR: [
              { categoryId: String(listing.categoryId) }, // Same category
              ...(listing.cityId ? [{ cityId: String(listing.cityId) }] : []), // Same city (if exists)
            ],
          },
        ],
      },
      take: 4,
      include: {
        images: { take: 1, orderBy: { isPrimary: "desc" } },
        city: true,
        category: true,
        promotions: {
          where: {
            isActive: true,
            OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
          },
          take: 1,
        },
      },
      orderBy: [
        { listingTier: "desc" }, // Premium first
        { createdAt: "desc" },
      ],
    });

    // Format response data
    const responseData = {
      listing: {
        ...listing,
      },
      similarListings: similarListings.map((listing) => ({
        ...listing,
        city: listing.city?.name || "Unknown Location",
      })),
    };

    res.json(responseData);
  } catch (error) {
    console.error("Listing details error:", error);

    // Handle Prisma specific errors
    if (error) {
      return res.status(500).json({
        message: "Database error",
        code: error.code,
      });
    }

    res.status(500).json({ message: "Error fetching listing details" });
  }
});

app.get("/listing/professional", async (req, res) => {
  try {
    const {
      search,
      category,
      location,
      type = "ALL",
      page = 1,
      limit = 9,
    } = req.query;

    const where = {
      status: "APPROVED",
    };

    if (type === "PROFESSIONAL") {
      where.type = "PROFESSIONAL";
    } else if (type === "PRIVATE_INDIVIDUAL") {
      where.type = "PRIVATE_INDIVIDUAL";
    } else {
      where.type = { in: ["PROFESSIONAL", "PRIVATE_INDIVIDUAL"] };
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (category && category !== "All Categories") {
      where.category = {
        name: category,
      };
    }

    if (location && location !== "All Locations") {
      where.city = {
        name: location,
      };
    }

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
        city: true, // Include city relation
        images: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    const total = await prisma.listing.count({ where });

    res.json({
      listings,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Error fetching listings:", error);
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

app.get("/listings/pending", authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      where: {
        userId: req.user.userId,
        status: "PENDING_APPROVAL",
      },
      include: {
        category: true,
        images: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(listings);
  } catch (error) {
    console.error("Pending listings error:", error);
    res.status(500).json({ message: "Error fetching pending listings" });
  }
});

app.get("/listings/archived", authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      where: {
        userId: req.user.userId,
        status: "ARCHIVED",
      },
      include: {
        category: true,
        images: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(listings);
  } catch (error) {
    console.error("Archived listings error:", error);
    res.status(500).json({ message: "Error fetching archived listings" });
  }
});

app.get(
  "/listings/:listingId/favorite/check",
  authenticateToken,
  async (req, res) => {
    try {
      const { listingId } = req.params;
      const userId = req.user.userId;

      const favorite = await prisma.favorite.findUnique({
        where: {
          userId_listingId: {
            userId: parseInt(userId),
            listingId: parseInt(listingId),
          },
        },
      });

      res.json({ isFavorite: !!favorite });
    } catch (error) {
      console.error("Error checking favorite:", error);
      res.status(500).json({ error: "Error checking favorite status" });
    }
  }
);

app.get("/listings/favorites", authenticateToken, async (req, res) => {
  try {
    // Assuming you have a favorites relation in your schema
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user.userId },
      include: {
        listing: {
          include: {
            category: true,
            images: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(favorites.map((fav) => fav.listing));
  } catch (error) {
    console.error("Favorites error:", error);
    res.status(500).json({ message: "Error fetching favorites" });
  }
});

app.put("/listings/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      type,
      price,
      negotiable,
      city,
      categoryId,
      highlights,
    } = req.body;

    const updatedListing = await prisma.listing.update({
      where: {
        id,
        userId: req.user.userId,
      },
      data: {
        title,
        description,
        type,
        price,
        negotiable,
        city,
        categoryId,
        highlights,
      },
      include: {
        category: true,
      },
    });

    res.json(updatedListing);
  } catch (error) {
    console.error("Update listing error:", error);
    res.status(500).json({ message: "Error updating listing" });
  }
});

app.delete("/listings/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.listing.delete({
      where: {
        id,
        userId: req.user.userId,
      },
    });

    res.json({ message: "Listing deleted successfully" });
  } catch (error) {
    console.error("Delete listing error:", error);
    res.status(500).json({ message: "Error deleting listing" });
  }
});

app.put("/listings/:id/archive", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await prisma.listing.update({
      where: {
        id,
        userId: req.user.userId,
      },
      data: {
        status: "ARCHIVED",
      },
    });

    res.json(listing);
  } catch (error) {
    console.error("Archive listing error:", error);
    res.status(500).json({ message: "Error archiving listing" });
  }
});

app.put("/listings/:id/reactivate", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await prisma.listing.update({
      where: {
        id,
        userId: req.user.userId,
      },
      data: {
        status: "APPROVED",
      },
    });

    res.json(listing);
  } catch (error) {
    console.error("Reactivate listing error:", error);
    res.status(500).json({ message: "Error reactivating listing" });
  }
});

app.post("/listings/:id/favorite", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const favorite = await prisma.favorite.create({
      data: {
        userId: req.user.userId,
        listingId: parseInt(id),
      },
      include: {
        listing: true,
      },
    });

    res.status(201).json(favorite);
  } catch (error) {
    console.error("Favorite error:", error);
    res.status(500).json({ message: "Error favoriting listing" });
  }
});

app.delete("/listings/:id/favorite", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.favorite.delete({
      where: {
        userId_listingId: {
          userId: req.user.userId,
          listingId: parseInt(id),
        },
      },
    });

    res.json({ message: "Removed from favorites" });
  } catch (error) {
    console.error("Unfavorite error:", error);
    res.status(500).json({ message: "Error removing from favorites" });
  }
});

app.post(
  "/upload",
  authenticateToken,
  upload.array("photos", 10),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      // Parse photo types from form data
      const photoTypes = [];
      for (let i = 0; i < req.files.length; i++) {
        const typeKey = `photoTypes[${i}]`;
        photoTypes.push(req.body[typeKey] || "gallery");
      }

      // Parse metadata if available
      let metadata = { featuredCount: 0, bannerCount: 0, galleryCount: 0 };
      if (req.body.photoMetadata) {
        try {
          metadata = JSON.parse(req.body.photoMetadata);
        } catch (e) {
          console.warn("Failed to parse photo metadata");
        }
      }

      const uploadPromises = req.files.map((file) => uploadFileToS3(file));
      const uploadedFiles = await Promise.all(uploadPromises);

      const urls = uploadedFiles.map((file, index) => ({
        url: file.url,
        filename: file.filename,
        key: file.key,
        type: photoTypes[index] || "gallery",
        isFeatured: photoTypes[index] === "featured",
        isBanner: photoTypes[index] === "banner",
        isGallery: photoTypes[index] === "gallery",
        order: index,
      }));

      const organizedUrls = {
        featured: urls.filter((img) => img.type === "featured"),
        banner: urls.filter((img) => img.type === "banner"),
        gallery: urls.filter((img) => img.type === "gallery"),
        all: urls,
      };

      res.status(200).json({
        urls: urls,
        organized: organizedUrls,
        metadata: {
          ...metadata,
          totalUploaded: urls.length,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to upload files" });
    }
  }
);

app.post("/listings", authenticateToken, async (req, res) => {
  try {
    const {
      category,
      type,
      title,
      description,
      price,
      negotiable,
      city,
      tags,
      highlights,
      phone,
      website,
      businessHours,
      businessCategory,
      establishedYear,
      serviceArea,
      teamSize,
      rating,
      reviewCount,
      listingTier = "FREE",
      subscriptionId,
      photos, // This should be an array of { url, isBanner }
      youtubeVideo,
      locationUrl,
      serviceRadius,
    } = req.body;

    if (!category || !title || !description || !city) {
      return res.status(400).json({
        error: "Category, title, description, and city are required",
      });
    }

    let subscriptionPlan = null;
    if (subscriptionId) {
      subscriptionPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: subscriptionId },
      });

      if (!subscriptionPlan) {
        return res.status(400).json({ error: "Invalid subscription plan" });
      }
    }

    let processedHours = {};
    if (businessHours) {
      if (typeof businessHours === "string") {
        try {
          processedHours = JSON.parse(businessHours);
        } catch (e) {
          console.error("Error parsing business hours", e);
        }
      } else {
        processedHours = businessHours;
      }
    }

    let categoryRecord = await prisma.category.findUnique({
      where: { name: category },
    });

    let cityRecord = await prisma.city.findUnique({
      where: { name: city },
    });

    if (!categoryRecord) {
      categoryRecord = await prisma.category.create({
        data: {
          name: category,
        },
      });
    }

    const baseSlug = title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w-]+/g, "");
    let slug = baseSlug;
    let counter = 1;

    while (await prisma.listing.findFirst({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    let initialStatus = "DRAFT";
    if (listingTier === "FREE") {
      initialStatus = "PENDING_APPROVAL";
    } else {
      initialStatus = "PENDING_PAYMENT";
    }

    let expiresAt;
    let isBannerEnabled = false;

    if (subscriptionPlan) {
      expiresAt = calculateExpirationDate(subscriptionPlan.durationDays);
      isBannerEnabled =
        subscriptionPlan.tierType !== "FREE" &&
        subscriptionPlan.promotionDays > 0;
    } else {
      // Default values if no subscription plan
      if (listingTier === "FREE") {
        expiresAt = calculateExpirationDate(30); // 30 days for FREE
      } else if (listingTier === "PREMIUM") {
        expiresAt = calculateExpirationDate(60); // 60 days for PREMIUM
        isBannerEnabled = true;
      } else if (listingTier === "PREMIUM_PLUS") {
        expiresAt = calculateExpirationDate(120); // 120 days for PREMIUM_PLUS
        isBannerEnabled = true;
      }
    }

    const newListing = await prisma.listing.create({
      data: {
        title,
        description,
        type: type === "Professional" ? "PROFESSIONAL" : "PRIVATE_INDIVIDUAL",
        price: parseFloat(price) || 0,
        negotiable: negotiable === "true" || negotiable === true,
        category: { connect: { id: categoryRecord.id } },
        user: { connect: { id: req.user.userId } },
        city: { connect: { id: cityRecord.id } },
        tags: Array.isArray(tags) ? tags : tags?.split(",") || [],
        highlights: Array.isArray(highlights)
          ? highlights
          : highlights?.split(",") || [],
        phone: phone || null,
        website: website || null,
        businessHours: processedHours,
        businessCategory: businessCategory || null,
        establishedYear: establishedYear ? parseInt(establishedYear) : null,
        serviceArea: serviceArea || null,
        teamSize: teamSize || null,
        rating: rating ? parseFloat(rating) : null,
        reviewCount: reviewCount ? parseInt(reviewCount) : null,
        listingTier: subscriptionPlan ? subscriptionPlan.tierType : listingTier,
        status: initialStatus,
        slug,
        expiresAt: expiresAt,
        isBannerEnabled,
        youtubeVideo: youtubeVideo || null,
        locationUrl: locationUrl || null,
        serviceRadius: serviceRadius ? parseInt(serviceRadius) : null,
        subscription: subscriptionPlan
          ? { connect: { id: subscriptionPlan.id } }
          : null,
      },
      include: {
        category: true,
        user: true,
      },
    });

    if (photos && photos.length > 0) {
      const bannerIndex = photos.findIndex((photo) => photo.isBanner);

      await prisma.image.createMany({
        data: photos.map((photo, index) => ({
          url: photo.url,
          isPrimary: index === 0,
          isBanner: index === bannerIndex,
          listingId: newListing.id,
        })),
      });
    }

    // Create promotion if applicable
    if (subscriptionPlan && subscriptionPlan.promotionDays > 0) {
      await prisma.promotion.create({
        data: {
          listingId: newListing.id,
          price: 0, // Included in subscription
          startDate: new Date(),
          endDate: calculateExpirationDate(subscriptionPlan.promotionDays),
          durationDays: subscriptionPlan.promotionDays,
          isActive: true,
        },
      });
    }

    if (
      listingTier === "FREE" ||
      (subscriptionPlan && subscriptionPlan.tierType === "FREE")
    ) {
      const admin = await prisma.admin.findFirst();

      if (admin) {
        await prisma.adminApproval.create({
          data: {
            listingId: newListing.id,
            adminId: admin.id,
            status: "PENDING_APPROVAL",
          },
        });
      } else {
        console.warn("No admin found to assign approval to");
      }
    }

    res.status(201).json({
      message: "Listing created successfully",
      listing: newListing,
      requiresPayment: initialStatus === "PENDING_PAYMENT",
    });
  } catch (error) {
    console.error("Error creating listing:", error);
    res.status(500).json({ error: "Failed to create listing" });
  }
});

app.delete("/images/:id", authenticateToken, async (req, res) => {
  try {
    const imageId = parseInt(req.params.id);

    const image = await prisma.image.findUnique({
      where: { id: imageId },
    });

    if (!image) {
      return res.status(404).json({ error: "Image not found" });
    }

    // Check if the image belongs to a listing owned by the user
    const listing = await prisma.listing.findUnique({
      where: { id: image.listingId },
    });

    if (!listing || listing.userId !== req.user.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Delete from S3 if key exists
    if (image.key) {
      await deleteFileFromS3(image.key);
    }

    // Delete from database
    await prisma.image.delete({
      where: { id: imageId },
    });

    res.status(200).json({ message: "Image deleted successfully" });
  } catch (error) {
    console.error("Error deleting image:", error);
    res.status(500).json({ error: "Failed to delete image" });
  }
});

app.get("/categories", async (req, res) => {
  try {
    const { search } = req.query;
    const categories = await prisma.category.findMany({
      where: search
        ? {
            name: {
              contains: search,
              mode: "insensitive",
            },
          }
        : {},
      take: 15,
      orderBy: {
        name: "asc",
      },
    });

    res.json(categories.map((cat) => cat.name));
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.get("/home-categories", async (req, res) => {
  try {
    const homeCategories = await prisma.homeCategory.findMany({
      include: {
        category: {
          include: {
            _count: {
              select: { listings: { where: { status: "APPROVED" } } },
            },
          },
        },
      },
      orderBy: { order: "asc" },
    });

    const transformed = homeCategories.map((hc) => ({
      id: hc.id,
      name: hc.name,
      categoryId: hc.categoryId,
      iconName: hc.iconName,
      color: hc.color,
      order: hc.order,
      _count: hc.category._count,
    }));

    res.json(transformed);
  } catch (error) {
    console.error("Error fetching home categories:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/cities", async (req, res) => {
  try {
    const { search } = req.query;
    const categories = await prisma.city.findMany({
      where: search
        ? {
            name: {
              contains: search,
              mode: "insensitive",
            },
          }
        : {},
      take: 15,
      orderBy: {
        name: "asc",
      },
    });

    res.json(categories.map((cat) => cat.name));
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.post("/cities", authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "Valid city name is required" });
    }

    const processedName = name.trim().toUpperCase();

    const city = await prisma.city.create({
      data: {
        name: processedName,
      },
    });

    res.status(201).json(city);
  } catch (error) {
    console.error("Create city error:", error);

    if (error.code === "P2002" && error.meta?.target?.includes("name")) {
      return res.status(409).json({ message: "City already exists" });
    }

    res.status(500).json({ message: "Error creating city" });
  }
});

app.get("/listings/random", async (req, res) => {
  try {
    const { pincode, limit } = req.query;
    const maxResults = parseInt(limit) || 6;

    // Get filtered and scored listings using hybrid system
    const listings = await getFilteredRandomListings(pincode, maxResults);
    res.json(formatListings(listings));
  } catch (error) {
    console.error("Error fetching random listings:", error);
    res.status(500).json({
      error: "Failed to fetch listings",
      details: error.message,
    });
  }
});

async function getFilteredRandomListings(userPincode, maxResults = 6) {
  // Get all approved listings
  const allListings = await getAllApprovedListings();

  // If no pincode provided, return all listings randomly
  if (!userPincode) {
    console.log(
      "No pincode provided - returning random listings from all available"
    );
    return getRandomListings(allListings, maxResults);
  }

  const userLocation = await getEnhancedLocationData(userPincode);

  if (!userLocation) {
    console.log(
      `Could not determine location for pincode: ${userPincode} - returning all listings`
    );
    return getRandomListings(allListings, maxResults);
  }

  console.log(`User location data for ${userPincode}:`, {
    district: userLocation.district,
    city: userLocation.city,
    coordinates: userLocation.coordinates,
  });

  // Categorize listings by location relevance
  const areaListings = []; // Same district/area
  const nearbyListings = []; // Nearby by distance
  const fallbackListings = []; // No location data

  for (const listing of allListings) {
    const listingLocation = await getListingLocationData(listing);

    // If listing has no location data, add to fallback
    if (!listingLocation) {
      fallbackListings.push(listing);
      continue;
    }

    // Check if listing is in the same area (district match)
    const isInSameArea = isListingInUserArea(userLocation, listingLocation);

    if (isInSameArea) {
      // Calculate score for sorting within area
      const score = calculateListingLocationScore(
        userLocation,
        listingLocation,
        listing
      );
      areaListings.push({ ...listing, locationScore: score });
    } else {
      // Calculate distance for nearby listings
      console.log(userLocation.coordinates, listingLocation.coordinates);
      if (userLocation.coordinates && listingLocation.coordinates) {
        const distance = calculateDistance(
          userLocation.coordinates.lat,
          userLocation.coordinates.lng,
          listingLocation.coordinates.lat,
          listingLocation.coordinates.lng
        );

        listing.distance = distance;
        nearbyListings.push({ ...listing, distance });
      } else {
        fallbackListings.push(listing);
      }
    }
  }

  console.log(
    `Categorization - Area: ${areaListings.length}, Nearby: ${nearbyListings.length}, Fallback: ${fallbackListings.length}`
  );

  // STRATEGY: Area-first approach
  let selectedListings = [];

  // 1. PRIORITY: Use area listings if available
  if (areaListings.length > 0) {
    console.log(
      `Found ${areaListings.length} listings in user's area - using area listings only`
    );

    // Sort area listings by score (highest first)
    areaListings.sort((a, b) => b.locationScore - a.locationScore);
    selectedListings = getRandomListings(areaListings, maxResults);
  } else {
    console.log(
      "No listings found in user's area - falling back to nearest listings"
    );

    // 2. FALLBACK: Use nearest listings sorted by distance
    if (nearbyListings.length > 0) {
      // Sort by distance (nearest first)
      nearbyListings.sort((a, b) => a.distance - b.distance);

      // Take the nearest listings up to maxResults
      const nearestListings = nearbyListings.slice(0, maxResults * 2); // Get more options for randomization
      selectedListings = getRandomListings(nearestListings, maxResults);

      console.log(
        `Using ${
          selectedListings.length
        } nearest listings (distances: ${selectedListings
          .map((l) => l.distance?.toFixed(1) + "km")
          .join(", ")})`
      );
    } else {
      console.log(
        "No nearby listings found - using fallback listings without location data"
      );
      selectedListings = getRandomListings(fallbackListings, maxResults);
    }
  }

  console.log(`Final selection - Total: ${selectedListings.length}`);

  // Light randomization to avoid predictable ordering while maintaining relevance
  return shuffleArray(selectedListings).slice(0, maxResults);
}

// Get all approved listings with necessary includes
async function getAllApprovedListings() {
  return await prisma.listing.findMany({
    where: { status: "APPROVED" },
    include: {
      category: true,
      city: true,
      images: {
        where: { isPrimary: true },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

function isListingInUserArea(userLocation, listingLocation) {
  if (!userLocation || !listingLocation) return false;

  // Primary check: Same district
  if (userLocation.district && listingLocation.district) {
    if (
      userLocation.district.toLowerCase() ===
      listingLocation.district.toLowerCase()
    ) {
      return true;
    }
  }

  // Secondary check: Same city (if no district match)
  if (userLocation.city && listingLocation.city) {
    if (
      userLocation.city.toLowerCase() === listingLocation.city.toLowerCase()
    ) {
      return true;
    }
  }

  // Tertiary check: Very close proximity (within 55km in same state)
  if (
    userLocation.coordinates &&
    listingLocation.coordinates &&
    userLocation.state &&
    listingLocation.state &&
    userLocation.state.toLowerCase() === listingLocation.state.toLowerCase()
  ) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      listingLocation.coordinates.lat,
      listingLocation.coordinates.lng
    );

    // Consider within 55km as "same area" if in same state
    return distance <= 55;
  }

  return false;
}

function calculateListingLocationScore(userLocation, listingLocation, listing) {
  if (!listingLocation) return 0;

  let score = 100; // Base score for being in area

  const bonusWeights = {
    exactCityMatch: 50,
    subDistrictMatch: 30,
    proximityBonus: 20,
    serviceRadiusBonus: 10,
  };

  // Bonus for exact city match
  if (
    userLocation.city &&
    listingLocation.city &&
    userLocation.city.toLowerCase() === listingLocation.city.toLowerCase()
  ) {
    score += bonusWeights.exactCityMatch;
  }

  // Bonus for sub-district match
  if (
    userLocation.subDistrict &&
    listingLocation.subDistrict &&
    userLocation.subDistrict.toLowerCase() ===
      listingLocation.subDistrict.toLowerCase()
  ) {
    score += bonusWeights.subDistrictMatch;
  }

  // Proximity bonus within area
  if (userLocation.coordinates && listingLocation.coordinates) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      listingLocation.coordinates.lat,
      listingLocation.coordinates.lng
    );

    listing.distance = distance;

    // Proximity bonus (within area)
    if (distance <= 5) score += bonusWeights.proximityBonus;
    else if (distance <= 10) score += bonusWeights.proximityBonus * 0.8;
    else if (distance <= 20) score += bonusWeights.proximityBonus * 0.6;

    // Service radius bonus
    if (listing.serviceRadius && distance <= listing.serviceRadius) {
      score += bonusWeights.serviceRadiusBonus;
    }
  }

  return Math.round(score);
}

// Get comprehensive location data for a listing
async function getListingLocationData(listing) {
  try {
    // Check cache first
    const cacheKey = `listing_location_${listing.id}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    let coordinates = null;
    let locationData = null;

    // Priority 1: Extract from Google Maps URL
    if (listing.locationUrl) {
      coordinates = await extractCoordsFromUrl(listing.locationUrl);
      if (coordinates) {
        locationData = await getLocationDataFromCoordinates(
          coordinates.lat,
          coordinates.lng
        );
      }
    }

    // Priority 2: Geocode from pincode
    if (!locationData && listing.pincode) {
      const pincodeLocation = await getEnhancedLocationData(listing.pincode);
      if (pincodeLocation) {
        locationData = pincodeLocation;
      }
    }

    // Priority 3: Geocode from city name
    if (!locationData && listing.city) {
      locationData = await getLocationDataFromCity(listing.city);
    }

    // Priority 4: Use city relation if available
    if (!locationData && listing.city && listing.city.name) {
      locationData = await getLocationDataFromCity(listing.city.name);
    }

    if (locationData) {
      // Cache the result
      locationCache.set(cacheKey, locationData);
    }

    return locationData;
  } catch (error) {
    console.error(
      `Error getting location data for listing ${listing.id}:`,
      error.message
    );
    return null;
  }
}

async function getLocationDataFromCity(cityName) {
  try {
    // Check cache first
    const cacheKey = `city_location_${cityName}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    // Try Google Geocoding first
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          address: `${cityName}, India`,
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      const locationData = {
        coordinates: result.geometry.location,
        district: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_2"
        ),
        subDistrict: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_3"
        ),
        city: extractFromAddressComponents(
          result.address_components,
          "locality"
        ),
        state: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_1"
        ),
        formattedAddress: result.formatted_address,
      };

      // Cache the result
      locationCache.set(cacheKey, locationData);
      return locationData;
    }

    // Fallback to OpenStreetMap
    const osmResponse = await axios.get(
      `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(
        cityName
      )}&country=India&format=json&limit=1`,
      {
        headers: {
          "User-Agent": "YourApp/1.0",
        },
      }
    );

    if (osmResponse.data && osmResponse.data.length > 0) {
      const result = osmResponse.data[0];
      const locationData = {
        coordinates: {
          lat: parseFloat(result.lat),
          lng: parseFloat(result.lon),
        },
        city: result.display_name.split(",")[0].trim(),
        formattedAddress: result.display_name,
      };

      // Try to get more detailed info from coordinates
      const detailedData = await getLocationDataFromCoordinates(
        locationData.coordinates.lat,
        locationData.coordinates.lng
      );

      const finalLocationData = detailedData || locationData;
      locationCache.set(cacheKey, finalLocationData);
      return finalLocationData;
    }

    return null;
  } catch (error) {
    console.error(`Error geocoding city ${cityName}:`, error.message);
    return null;
  }
}

// Enhanced random selection with Fisher-Yates shuffle
function getRandomListings(listings, count) {
  if (listings.length <= count) {
    return [...listings];
  }

  const shuffled = [...listings];

  // Fisher-Yates shuffle algorithm
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, count);
}

// Enhanced listing formatter with location score and distance
function formatListings(listings) {
  return listings.map((listing) => ({
    id: listing.id,
    title: listing.title,
    category: listing.category?.name || "Uncategorized",
    subcategory: listing.businessCategory || "",
    location: listing.city?.name || listing.city || "Unknown",
    date: listing.createdAt.toISOString(),
    images: listing.images?.length || 0,
    imageSrc: listing.images?.[0]?.url || "/api/placeholder/400/300",
    distance: listing.distance
      ? `${listing.distance.toFixed(1)} km`
      : undefined,
    locationScore: listing.locationScore || 0, // For debugging - can be removed in production
    slug: listing.slug,
    price: listing.price,
    isPromoted: listing.isPromoted || false,
  }));
}

// Distance calculation using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

app.post("/listings/:id/promote", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { durationDays, promotionType } = req.body;

    const listing = await prisma.listing.findUnique({
      where: { id: parseInt(id) },
      include: { subscription: true },
    });

    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }

    if (listing.userId !== req.user.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Check if listing has active subscription with promotion
    if (listing.subscription && listing.subscription.promotionDays > 0) {
      return res.status(400).json({
        error: "Listing already has promotion through subscription",
      });
    }

    // Check if listing is eligible for banner
    const isBannerEligible = listing.listingTier !== "FREE";

    const promotion = await prisma.promotion.create({
      data: {
        listingId: listing.id,
        price: 0, // You might want to charge for promotions
        startDate: new Date(),
        endDate: calculateExpirationDate(durationDays),
        durationDays,
        isActive: true,
      },
    });

    // Enable banner if eligible
    if (isBannerEligible) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { isBannerEnabled: true },
      });
    }

    res.status(201).json({
      message: "Listing promoted successfully",
      promotion,
      bannerEnabled: isBannerEligible,
    });
  } catch (error) {
    console.error("Promotion error:", error);
    res.status(500).json({ error: "Failed to promote listing" });
  }
});

app.get("/home-banner", async (req, res) => {
  try {
    const banners = await prisma.banner.findMany({
      where: { active: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// app.get("/admin-banners", async (req, res) => {
//   try {
//     const banners = await prisma.adminBanner.findMany({
//       where: { active: true },
//       orderBy: { createdAt: "desc" },
//     });
//     res.json(banners);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to fetch banners" });
//   }
// });

app.get("/pages", async (req, res) => {
  try {
    const pages = await prisma.page.findMany({
      orderBy: { updatedAt: "desc" },
    });
    res.json(pages);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pages" });
  }
});

app.get("/pages/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const page = await prisma.page.findUnique({
      where: { slug },
    });

    if (!page) {
      return res.status(404).json({ error: "Page not found" });
    }

    res.json(page);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch page" });
  }
});

app.get("/middle-banners", async (req, res) => {
  try {
    const userPincode = req.query.location?.toString();
    const maxResults = parseInt(req.query.limit) || 10;

    const banners = await getFilteredMiddleBanners(userPincode, maxResults);
    console.log(
      `Returning ${banners.length} banners for pincode: ${userPincode || "all"}`
    );
    res.json(formatMiddleBanners(banners));
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

app.get("/bottom-banners", async (req, res) => {
  try {
    const userPincode = req.query.location?.toString();
    const maxResults = parseInt(req.query.limit) || 10;

    const banners = await getFilteredBottomBanners(userPincode, maxResults);
    console.log(
      `Returning ${banners.length} banners for pincode: ${userPincode || "all"}`
    );
    res.json(formatBottomBanners(banners));
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

app.get("/hero-banners", async (req, res) => {
  try {
    const userPincode = req.query.location?.toString();
    const maxResults = parseInt(req.query.limit) || 10;

    const banners = await getFilteredHeroBanners(userPincode, maxResults);
    console.log(
      `Returning ${banners.length} banners for pincode: ${userPincode || "all"}`
    );
    res.json(formatHeroBanners(banners));
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

app.get("/category-banners", async (req, res) => {
  try {
    const userPincode = req.query.location?.toString();
    const categoryName = req.query.category?.toString();
    const maxResults = parseInt(req.query.limit) || 10;

    const banners = await getFilteredCategoryBanners(
      categoryName,
      userPincode,
      maxResults
    );
    console.log(
      `Returning ${banners.length} banners for pincode: ${userPincode || "all"}`
    );
    res.json(formatCategoryBanners(banners));
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

async function getFilteredBanners(userPincode, maxResults = 10) {
  const allBanners = await getAllEligibleBanners();

  // If no pincode provided, return all banners randomly
  if (!userPincode) {
    console.log(
      "No pincode provided - returning random banners from all available"
    );
    return shuffleArray(allBanners).slice(0, maxResults);
  }

  // Get enhanced user location data
  const userLocation = await getEnhancedLocationData(userPincode);

  if (!userLocation) {
    console.log(
      `Could not determine location for pincode: ${userPincode} - returning all banners`
    );
    return shuffleArray(allBanners).slice(0, maxResults);
  }

  console.log(`User location data for ${userPincode}:`, {
    district: userLocation.district,
    city: userLocation.city,
    state: userLocation.state,
    coordinates: userLocation.coordinates,
  });

  // Categorize banners by location relevance
  const areaBanners = []; // Same district/area
  const nearbyBanners = []; // Within 55km in same state
  const fallbackBanners = []; // No location data or no location restrictions

  for (const banner of allBanners) {
    const bannerLocation = await getBannerLocationData(banner);

    // If banner has no location data, check if it has any location restrictions
    if (!bannerLocation) {
      // Only include banners without ANY location restrictions in fallback
      if (!banner.locationUrl && !banner.pincode && !banner.city) {
        fallbackBanners.push({ ...banner, locationScore: 50 }); // Medium priority for global banners
        console.log(
          `Global banner ${banner.id} added to fallback (no location restrictions)`
        );
      } else {
        console.log(
          `Banner ${banner.id} skipped (has location fields but couldn't resolve location)`
        );
      }
      continue;
    }

    // Check if banner is in the same area (district match)
    const isInSameArea = isBannerInUserArea(userLocation, bannerLocation);

    if (isInSameArea) {
      // Calculate score for sorting within area
      const score = calculateBannerLocationScore(
        userLocation,
        bannerLocation,
        banner
      );
      areaBanners.push({ ...banner, locationScore: score });
      console.log(
        `✓ Area banner ${banner.id}: ${
          bannerLocation?.district || "No district"
        } (Score: ${score})`
      );
    } else {
      // Check if banner is within 55km radius and in same state
      if (
        userLocation.coordinates &&
        bannerLocation.coordinates &&
        userLocation.state &&
        bannerLocation.state &&
        userLocation.state.toLowerCase() === bannerLocation.state.toLowerCase()
      ) {
        const distance = calculateDistance(
          userLocation.coordinates.lat,
          userLocation.coordinates.lng,
          bannerLocation.coordinates.lat,
          bannerLocation.coordinates.lng
        );

        // Check 55km radius within same state
        if (distance <= 55) {
          banner.distance = distance;
          nearbyBanners.push({ ...banner, distance });
          console.log(
            `→ Nearby banner ${banner.id}: ${distance.toFixed(
              1
            )}km away (same state)`
          );
        } else {
          console.log(
            `Banner ${
              banner.id
            } excluded - outside 55km radius (${distance.toFixed(1)}km > 55km)`
          );
        }
      } else {
        // No coordinates available or different state, add to fallback if no location restrictions
        if (!banner.locationUrl && !banner.pincode && !banner.city) {
          fallbackBanners.push({ ...banner, locationScore: 25 });
        } else {
          console.log(
            `Banner ${banner.id} excluded - different state or no coordinates`
          );
        }
      }
    }
  }

  console.log(
    `Banner categorization - Area: ${areaBanners.length}, Nearby: ${nearbyBanners.length}, Fallback: ${fallbackBanners.length}`
  );

  // STRATEGY: Area-first approach
  let selectedBanners = [];

  // 1. PRIORITY: Use area banners if available
  if (areaBanners.length > 0) {
    console.log(
      `Found ${areaBanners.length} banners in user's area - using area banners only`
    );

    // Sort area banners by score (highest first)
    areaBanners.sort((a, b) => b.locationScore - a.locationScore);
    selectedBanners = areaBanners.slice(0, maxResults);
  } else {
    console.log(
      "No banners found in user's area - falling back to nearest banners within 55km"
    );

    // 2. FALLBACK: Use nearest banners within 55km sorted by distance
    if (nearbyBanners.length > 0) {
      // Sort by distance (nearest first)
      nearbyBanners.sort((a, b) => a.distance - b.distance);
      selectedBanners = nearbyBanners.slice(0, maxResults);

      console.log(
        `Using ${
          selectedBanners.length
        } nearest banners within 55km (distances: ${selectedBanners
          .map((b) => b.distance?.toFixed(1) + "km")
          .join(", ")})`
      );
    } else {
      // 3. LAST RESORT: Use fallback banners (global banners with no location restrictions)
      console.log(
        "No nearby banners found within 55km - using global banners without location restrictions"
      );
      selectedBanners = fallbackBanners.slice(0, maxResults);
    }
  }

  console.log(`Final banner selection - Total: ${selectedBanners.length}`);

  // Light shuffle to avoid predictable ordering while maintaining relevance
  return shuffleArray(selectedBanners).slice(0, maxResults);
}

// Check if banner is in user's area (same district or administrative boundary)
function isBannerInUserArea(userLocation, bannerLocation) {
  if (!userLocation || !bannerLocation) return false;

  // Primary check: Same district
  if (userLocation.district && bannerLocation.district) {
    if (
      userLocation.district.toLowerCase() ===
      bannerLocation.district.toLowerCase()
    ) {
      return true;
    }
  }

  // Secondary check: Same city (if no district match)
  if (userLocation.city && bannerLocation.city) {
    if (userLocation.city.toLowerCase() === bannerLocation.city.toLowerCase()) {
      return true;
    }
  }

  // Tertiary check: Very close proximity (within 15km in same state)
  if (
    userLocation.coordinates &&
    bannerLocation.coordinates &&
    userLocation.state &&
    bannerLocation.state &&
    userLocation.state.toLowerCase() === bannerLocation.state.toLowerCase()
  ) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      bannerLocation.coordinates.lat,
      bannerLocation.coordinates.lng
    );

    // Consider within 55km as "same area" if in same state
    return distance <= 55;
  }

  return false;
}

async function getAllEligibleBanners() {
  const currentDate = new Date();

  return await prisma.listing.findMany({
    where: {
      status: "APPROVED",
      isBannerEnabled: true,
      OR: [
        {
          promotions: {
            some: {
              isActive: true,
              OR: [{ endDate: null }, { endDate: { gte: currentDate } }],
            },
          },
        },
        { subscription: { promotionDays: { gt: 0 }, isActive: true } },
      ],
    },
    include: {
      category: true,
      city: true,
      images: { where: { isBanner: true }, take: 1 },
      promotions: {
        where: {
          isActive: true,
          OR: [{ endDate: null }, { endDate: { gte: currentDate } }],
        },
        orderBy: { startDate: "desc" },
        take: 1,
      },
      subscription: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

// async function getAllEligibleBanners() {

// }

function calculateBannerLocationScore(userLocation, bannerLocation, banner) {
  if (!bannerLocation) return 0;

  let score = 100; // Base score for being in area

  const bonusWeights = {
    exactCityMatch: 50,
    subDistrictMatch: 30,
    proximityBonus: 20,
  };

  // Bonus for exact city match
  if (
    userLocation.city &&
    bannerLocation.city &&
    userLocation.city.toLowerCase() === bannerLocation.city.toLowerCase()
  ) {
    score += bonusWeights.exactCityMatch;
    console.log(`✓ City match for banner ${banner.id}: ${bannerLocation.city}`);
  }

  // Bonus for sub-district match
  if (
    userLocation.subDistrict &&
    bannerLocation.subDistrict &&
    userLocation.subDistrict.toLowerCase() ===
      bannerLocation.subDistrict.toLowerCase()
  ) {
    score += bonusWeights.subDistrictMatch;
    console.log(
      `✓ Sub-district match for banner ${banner.id}: ${bannerLocation.subDistrict}`
    );
  }

  // Proximity bonus within area
  if (userLocation.coordinates && bannerLocation.coordinates) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      bannerLocation.coordinates.lat,
      bannerLocation.coordinates.lng
    );

    banner.distance = distance;
    console.log(`Distance for banner ${banner.id}: ${distance.toFixed(2)}km`);

    // Proximity bonus (within area)
    if (distance <= 5) score += bonusWeights.proximityBonus;
    else if (distance <= 10) score += bonusWeights.proximityBonus * 0.8;
    else if (distance <= 20) score += bonusWeights.proximityBonus * 0.6;
  }

  return Math.round(score);
}

async function getBannerLocationData(banner) {
  try {
    // Check cache first
    const cacheKey = `banner_location_${banner.id}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    let coordinates = null;
    let locationData = null;

    // Priority 1: Extract from Google Maps URL (locationUrl)
    if (banner.locationUrl) {
      coordinates = await extractCoordsFromUrl(banner.locationUrl);
      if (coordinates) {
        locationData = await getLocationDataFromCoordinates(
          coordinates.lat,
          coordinates.lng
        );
        console.log(
          `✓ Got location data from locationUrl for banner ${banner.id}`
        );
      }
    }

    // Priority 2: Geocode from pincode
    if (!locationData && banner.pincode) {
      const pincodeLocation = await getEnhancedLocationData(banner.pincode);
      if (pincodeLocation) {
        locationData = pincodeLocation;
        console.log(
          `✓ Got location data from pincode ${banner.pincode} for banner ${banner.id}`
        );
      }
    }

    // Priority 3: Geocode from city name
    if (!locationData && banner.city) {
      locationData = await getLocationDataFromCity(banner.city);
      if (locationData) {
        console.log(`✓ Got location data from city for banner ${banner.id}`);
      }
    }

    // Priority 4: Use city relation if available
    if (!locationData && banner.city && banner.city.name) {
      locationData = await getLocationDataFromCity(banner.city.name);
      if (locationData) {
        console.log(
          `✓ Got location data from city relation for banner ${banner.id}`
        );
      }
    }

    if (locationData) {
      // Cache the result
      locationCache.set(cacheKey, locationData);
      console.log(`Cached location data for banner ${banner.id}:`, {
        district: locationData.district,
        city: locationData.city,
        coordinates: locationData.coordinates,
      });
    } else {
      console.log(`⚠️ Could not determine location for banner ${banner.id}`);
    }

    return locationData;
  } catch (error) {
    console.error(
      `Error getting location data for banner ${banner.id}:`,
      error.message
    );
    return null;
  }
}

// Get detailed location data from coordinates
async function getLocationDataFromCoordinates(lat, lng) {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          latlng: `${lat},${lng}`,
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      return {
        coordinates: { lat, lng },
        district: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_2"
        ),
        subDistrict: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_3"
        ),
        city: extractFromAddressComponents(
          result.address_components,
          "locality"
        ),
        state: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_1"
        ),
        pincode: extractFromAddressComponents(
          result.address_components,
          "postal_code"
        ),
        formattedAddress: result.formatted_address,
      };
    }

    return null;
  } catch (error) {
    console.error(
      `Failed to get location data for coordinates ${lat}, ${lng}:`,
      error.message
    );
    return null;
  }
}

// Enhanced location data extraction for user pincode
async function getEnhancedLocationData(pincode) {
  try {
    // Check cache first
    const cacheKey = `enhanced_location_${pincode}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          address: pincode,
          components: "country:IN",
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      const locationData = {
        coordinates: result.geometry.location,
        district: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_2"
        ),
        subDistrict: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_3"
        ),
        city: extractFromAddressComponents(
          result.address_components,
          "locality"
        ),
        state: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_1"
        ),
        pincode: extractFromAddressComponents(
          result.address_components,
          "postal_code"
        ),
        formattedAddress: result.formatted_address,
      };

      // Cache the result
      locationCache.set(cacheKey, locationData);

      return locationData;
    }

    return null;
  } catch (error) {
    console.error(`Enhanced location lookup failed for ${pincode}:`, error);
    return null;
  }
}

// Extract specific component from Google's address components
function extractFromAddressComponents(addressComponents, targetType) {
  const component = addressComponents.find((comp) =>
    comp.types.includes(targetType)
  );
  return component?.long_name || null;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function extractCoordsFromUrl(url) {
  try {
    // Handle shortened URLs
    if (url.includes("goo.gl") || url.includes("maps.app.goo.gl")) {
      url = await resolveShortUrl(url);
    }

    // Method 1: Extract from @ parameter
    if (url.includes("@")) {
      const parts = url.split("@")[1].split(",");
      if (parts.length >= 2) {
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    // Method 2: Extract from query parameters
    const urlObj = new URL(url);
    const qParam = urlObj.searchParams.get("q");
    if (qParam) {
      const coords = qParam.split(",");
      if (coords.length === 2) {
        const lat = parseFloat(coords[0]);
        const lng = parseFloat(coords[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    // Method 3: Extract from place format (!3d and !4d)
    const placeMatch = url.match(/!3d([\d.-]+)!4d([\d.-]+)/);
    if (placeMatch) {
      const lat = parseFloat(placeMatch[1]);
      const lng = parseFloat(placeMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng };
      }
    }

    console.log(`Could not extract coordinates from URL: ${url}`);
    return null;
  } catch (error) {
    console.error(`Error extracting coords from URL ${url}:`, error.message);
    return null;
  }
}

// Enhanced URL resolution with better error handling
async function resolveShortUrl(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 10,
      timeout: 5000,
      validateStatus: null,
    });

    const resolvedUrl =
      response.request?.res?.responseUrl || response.headers?.location || url;

    console.log(`Resolved ${url} -> ${resolvedUrl}`);
    return resolvedUrl;
  } catch (error) {
    console.error(`Error resolving short URL ${url}:`, error.message);
    return url;
  }
}

// Enhanced banner formatting with location score
function formatBanners(banners) {
  return banners.map((listing) => {
    const promotion =
      listing.promotions[0] ||
      (listing.subscription
        ? {
            startDate: listing.createdAt,
            endDate: new Date(
              listing.createdAt.getTime() +
                listing.subscription.promotionDays * 86400000
            ),
            durationDays: listing.subscription.promotionDays,
            isActive: true,
          }
        : null);

    return {
      id: listing.id,
      imageUrl: listing.images[0]?.url || "/placeholder-banner.jpg",
      title: listing.title,
      subtitle: `${listing.category?.name || "Item"} in ${
        listing.city?.name || "your area"
      }`,
      link: `/list/${listing.slug}`,
      promotionType: "STANDARD",
      promotionEndDate: promotion?.endDate,
      isSubscriptionPromotion:
        !listing.promotions.length && !!listing.subscription,
      locationScore: listing.locationScore || 0,
    };
  });
}

async function getDistrictFromPincode(pincode) {
  try {
    // Google Geocoding attempt
    const res = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          address: pincode,
          region: "in",
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    const components = res.data?.results?.[0]?.address_components;
    if (components) {
      const district = extractDistrictFromAddressComponents(components);
      if (district) return district;
    }

    // 🔁 Fallback: India Post API
    const indiaPostRes = await axios.get(
      `https://api.postalpincode.in/pincode/${pincode}`
    );
    const districtFallback =
      indiaPostRes.data?.[0]?.PostOffice?.[0]?.District || null;
    console.log(indiaPostRes.data?.[0]?.PostOffice);
    if (districtFallback) {
      console.log(
        `[Fallback] Got district from India Post API: ${districtFallback}`
      );
      return districtFallback;
    }

    console.warn(`District could not be resolved for pincode ${pincode}`);
    return null;
  } catch (error) {
    console.error("Error in getDistrictFromPincode:", error.message);
    return null;
  }
}

function extractDistrictFromAddressComponents(addressComponents) {
  // Look for district in address components
  // Google Maps API uses different types for administrative areas
  const districtTypes = [
    "administrative_area_level_2", // District level in India
    "administrative_area_level_3", // Sub-district level
    "locality", // City/town level
  ];

  for (const component of addressComponents) {
    for (const type of districtTypes) {
      if (component.types.includes(type)) {
        return component.long_name;
      }
    }
  }

  return null;
}

async function getDistrictFromCoordinates(lat, lng) {
  try {
    // Check cache first
    const cacheKey = `district_${lat}_${lng}`;
    const cachedDistrict = pincodeCache.get(cacheKey);
    if (cachedDistrict) return cachedDistrict;

    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          latlng: `${lat},${lng}`,
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      // Extract district from address components
      const district = extractDistrictFromAddressComponents(
        result.address_components
      );

      console.log(district, "listing");

      if (district) {
        // Cache the result
        pincodeCache.set(cacheKey, district);
        return district;
      }
    }

    return null;
  } catch (error) {
    console.error(
      `Failed to get district for coordinates ${lat}, ${lng}:`,
      error.message
    );
    return null;
  }
}

export const locationCache = new Map();

setInterval(() => {
  locationCache.clear();
  console.log("Location cache cleared");
}, 6 * 60 * 60 * 1000);

app.get("/subscription-plans", async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { price: "asc" },
    });

    if (plans.length === 0) {
      const defaultPlans = [
        {
          name: "Free",
          description: "Basic listing for 30 days",
          durationDays: 30,
          promotionDays: 0,
          tierType: "FREE",
          price: 0,
          isActive: true,
        },
        {
          name: "Premium",
          description: "60-day listing with 7-day promotion",
          durationDays: 60,
          promotionDays: 7,
          tierType: "PREMIUM",
          price: 29.99,
          isActive: true,
        },
        {
          name: "Premium Plus",
          description: "120-day listing with 30-day promotion",
          durationDays: 120,
          promotionDays: 30,
          tierType: "PREMIUM_PLUS",
          price: 79.99,
          isActive: true,
        },
      ];

      const createdPlans = await Promise.all(
        defaultPlans.map((plan) =>
          prisma.subscriptionPlan.create({ data: plan })
        )
      );

      res.json(createdPlans);
    } else {
      res.json(plans);
    }
  } catch (error) {
    console.error("Error fetching subscription plans:", error);
    res.status(500).json({ error: "Failed to fetch subscription plans" });
  }
});

app.get("/payment", authenticateToken, async (req, res) => {
  try {
    // Get all payments for listings owned by the authenticated user
    const payments = await prisma.payment.findMany({
      where: {
        listing: {
          userId: req.user.userId,
        },
      },
      include: {
        listing: {
          select: {
            title: true,
            status: true,
            listingTier: true,
            subscription: {
              select: {
                name: true,
                durationDays: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!payments || payments.length === 0) {
      return res
        .status(404)
        .json({ message: "No payments found for this user" });
    }

    // Format the response data
    const formattedPayments = payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      transactionId: payment.transactionId,
      createdAt: payment.createdAt,
      listing: {
        id: payment.listingId,
        title: payment.listing.title,
        status: payment.listing.status,
        tier: payment.listing.listingTier,
        subscription: payment.listing.subscription,
      },
    }));

    res.json({
      success: true,
      data: formattedPayments,
    });
  } catch (error) {
    console.error("Payment fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch payment history",
      details: error.message,
    });
  }
});

app.get("/offer-zone", async (req, res) => {
  try {
    const currentDate = new Date().toISOString().split("T")[0];

    const offers = await prisma.offerZone.findMany({
      where: {
        isActive: true,
        validUntil: {
          gte: currentDate,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        vendorName: true,
        discount: true,
        promoCode: true,
        category: true,
        link: true,
        description: true,
        validUntil: true,
        rating: true,
      },
    });

    if (offers.length === 0) {
      return res.status(200).json({
        success: false,
        message: "No active offers found",
        data: [],
      });
    }

    res.status(200).json({
      success: true,
      count: offers.length,
      data: offers,
    });
  } catch (error) {
    console.error("Error fetching offers:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  } finally {
    await prisma.$disconnect();
  }
});

app.get("/reviews", async (req, res) => {
  try {
    const { listingId } = req.query;

    const reviews = await prisma.review.findMany({
      where: { listingId: parseInt(listingId) },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ reviews });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

// Create a new review
app.post("/reviews", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { title, description, rating, listingId } = req.body;

    // Validate input
    if (!title || !description || !rating || !listingId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if user already reviewed this listing
    const existingReview = await prisma.review.findFirst({
      where: {
        listingId: parseInt(listingId),
        userId: parseInt(userId),
      },
    });

    if (existingReview) {
      return res
        .status(400)
        .json({ error: "You have already reviewed this listing" });
    }

    const review = await prisma.review.create({
      data: {
        title,
        description,
        rating: parseInt(rating),
        listingId: parseInt(listingId),
        userId: parseInt(userId),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Update listing's review stats
    await updateListingStats(parseInt(listingId));

    res.status(201).json({ review });
  } catch (error) {
    console.error("Error creating review:", error);
    res.status(500).json({ error: "Failed to create review" });
  }
});

// Update a review
app.put("/reviews/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, rating, listingId } = req.body;

    // Validate input
    if (!title || !description || !rating) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const review = await prisma.review.update({
      where: { id },
      data: {
        title,
        description,
        rating: parseInt(rating),
        updatedAt: new Date(),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Update listing's review stats
    await updateListingStats(parseInt(listingId));

    res.json({ review });
  } catch (error) {
    console.error("Error updating review:", error);
    res.status(500).json({ error: "Failed to update review" });
  }
});

// Delete a review
app.delete("/reviews/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    await prisma.review.delete({
      where: { id },
    });

    // Update listing's review stats
    await updateListingStats(review.listingId);

    res.json({ message: "Review deleted successfully" });
  } catch (error) {
    console.error("Error deleting review:", error);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

// Helper function to update listing's review stats
async function updateListingStats(listingId) {
  try {
    // Get all approved reviews for this listing
    const reviews = await prisma.review.findMany({
      where: {
        listingId,
      },
    });

    const reviewCount = reviews.length;
    const averageRating =
      reviewCount > 0
        ? parseFloat(
            (
              reviews.reduce((sum, review) => sum + review.rating, 0) /
              reviewCount
            ).toFixed(1)
          )
        : null;

    // Update the listing with new stats
    await prisma.listing.updateMany({
      where: { id: listingId },
      data: {
        reviewCount,
        rating: averageRating,
      },
    });

    console.log(
      `Updated listing ${listingId} with ${reviewCount} reviews and rating ${averageRating}`
    );
  } catch (error) {
    console.error("Error updating listing stats:", error);
    throw error;
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
