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
      where: { userId: req.user.userId, status: { not: "PENDING_PAYMENT" } },
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
  upload.array("photos", 5),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const bannerIndex = parseInt(req.body.bannerIndex) || 0;

      // Upload files to S3
      const uploadPromises = req.files.map((file) => uploadFileToS3(file));
      const uploadedFiles = await Promise.all(uploadPromises);

      const urls = uploadedFiles.map((file, index) => ({
        url: file.url,
        filename: file.filename,
        key: file.key,
        isBanner: index === bannerIndex,
      }));

      res.status(200).json({ urls });
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
      youtubeVideo,
      locationUrl,
      serviceRadius,
    } = req.body;

    if (!category || !title || !description || !city) {
      return res.status(400).json({
        error: "Category, title, description, and city are required",
      });
    }

    // Get subscription plan details if provided
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

    // Calculate expiration date based on tier
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
    const { pincode } = req.query;

    if (!pincode) {
      // Fallback to original random sampling if no pincode provided
      const total = await prisma.listing.count({
        where: { status: "APPROVED" },
      });
      const skip = Math.floor(Math.random() * Math.max(0, total - 6));

      const listings = await prisma.listing.findMany({
        where: { status: "APPROVED" },
        include: {
          category: true,
          images: {
            where: { isPrimary: true },
            take: 1,
          },
        },
        take: 6,
        skip: skip,
        orderBy: { createdAt: "desc" },
      });

      return res.json(formatListings(listings));
    }

    // Step 1: Convert pincode to coordinates using a geocoding API
    const pincodeCoords = await getCoordinatesFromPincode(pincode);
    if (!pincodeCoords) {
      return res.status(400).json({
        error: "Could not determine location for the provided pincode",
      });
    }

    // Step 2: Get all approved listings with their location data
    const allListings = await prisma.listing.findMany({
      where: { status: "APPROVED" },
      include: {
        category: true,
        images: {
          where: { isPrimary: true },
          take: 1,
        },
      },
    });

    // Step 3: Calculate distance for each listing and sort by nearest
    const listingsWithDistance = await Promise.all(
      allListings.map(async (listing) => {
        try {
          // Get coordinates from listing's location data (could be address, pincode, etc.)
          const listingCoords = await getCoordinatesFromListing(listing);
          if (!listingCoords) {
            return { ...listing, distance: Infinity };
          }

          const distance = calculateDistance(
            pincodeCoords.lat,
            pincodeCoords.lng,
            listingCoords.lat,
            listingCoords.lng
          );

          return { ...listing, distance };
        } catch (error) {
          console.error(`Error processing listing ${listing.id}:`, error);
          return { ...listing, distance: Infinity };
        }
      })
    );

    // Step 4: Filter out invalid listings and get the nearest 6
    const nearestListings = listingsWithDistance
      .filter((listing) => listing.distance !== Infinity)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6);

    res.json(formatListings(nearestListings));
  } catch (error) {
    console.error("Error fetching listings:", error);
    res.status(500).json({
      error: "Failed to fetch listings",
      details: error.message,
    });
  }
});

// Helper function to get coordinates from a listing
async function getCoordinatesFromListing(listing) {
  // Priority 1: If listing has a Google Maps URL, extract coords from it
  if (listing.locationUrl) {
    const coords = await extractCoordsFromUrl(listing.locationUrl);
    if (coords) return coords;
  }

  // Priority 2: If listing has a pincode, geocode it
  if (listing.pincode) {
    const coords = await getCoordinatesFromPincode(listing.pincode);
    if (coords) return coords;
  }

  // Priority 3: If listing has city/address, try to geocode that
  if (listing.city) {
    try {
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(
          listing.city
        )}&format=json&limit=1`
      );
      if (response.data && response.data.length > 0) {
        return {
          lat: parseFloat(response.data[0].lat),
          lng: parseFloat(response.data[0].lon),
        };
      }
    } catch (error) {
      console.error("Error geocoding city:", error);
    }
  }

  return null;
}

// Helper function to format listings response
function formatListings(listings) {
  return listings.map((listing) => ({
    id: listing.id,
    title: listing.title,
    category: listing.category.name,
    subcategory: listing.businessCategory || "",
    location: listing.city,
    date: listing.createdAt.toISOString(),
    images:
      listing.images.length +
      (listing.images.some((img) => img.isPrimary) ? 0 : 1),
    imageSrc: listing.images[0]?.url || "/api/placeholder/400/300",
    distance: listing.distance
      ? `${listing.distance.toFixed(1)} km`
      : undefined,
  }));
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

app.get("/banners", async (req, res) => {
  try {
    const currentDate = new Date();
    const userPincode = req.query.pincode?.toString();

    // Base query
    const banners = await prisma.listing.findMany({
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

    // If no pincode, return all banners
    if (!userPincode) {
      return res.json(formatBanners(banners.slice(0, 10)));
    }

    // Get coordinates from geocoding service
    const userCoords = await getCoordinatesFromPincode(userPincode);

    // Filter banners based on location
    const filteredBanners = await Promise.all(
      banners.map(async (listing) => {
        // Always include listings without service radius
        if (
          listing.serviceRadius === null ||
          listing.serviceRadius === undefined
        ) {
          return listing;
        }

        // Exclude listings that require location if we don't have user coordinates
        if (!userCoords) {
          return null;
        }

        // Skip listings without locationUrl if they have service radius
        if (!listing.locationUrl) {
          return null;
        }

        try {
          const listingCoords = await extractCoordsFromUrl(listing.locationUrl);
          if (!listingCoords) return null;

          const distance = calculateDistance(
            userCoords.lat,
            userCoords.lng,
            listingCoords.lat,
            listingCoords.lng
          );

          console.log(`Distance for listing ${listing.id}:`, distance, "km");
          console.log(
            `Service radius for listing ${listing.id}:`,
            listing.serviceRadius,
            "km"
          );

          // Convert both to meters for comparison
          const distanceInMeters = distance * 1000;
          const radiusInMeters = listing.serviceRadius * 1000;

          // Only include if distance is within service radius
          if (distanceInMeters <= radiusInMeters) {
            console.log(`Including listing ${listing.id} - within radius`);
            return listing;
          } else {
            console.log(`Excluding listing ${listing.id} - outside radius`);
            return null;
          }
        } catch (error) {
          console.error(
            `Error processing listing ${listing.id}:`,
            error.message
          );
          return null;
        }
      })
    );

    // Filter out null values and get the first 10
    const validBanners = filteredBanners.filter(Boolean).slice(0, 10);

    console.log("Final banners count:", validBanners.length);
    res.json(formatBanners(validBanners));
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

async function resolveShortUrl(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 5,
      validateStatus: null,
    });
    return response.request.res.responseUrl || url;
  } catch (error) {
    console.error(`Error resolving short URL ${url}:`, error.message);
    return url; // Return original if resolution fails
  }
}

// Helper function to extract coordinates from URL
async function extractCoordsFromUrl(url) {
  try {
    if (url.includes("goo.gl") || url.includes("maps.app.goo.gl")) {
      url = await resolveShortUrl(url);
    }

    // Rest of your existing code remains the same...
    if (url.includes("@")) {
      const parts = url.split("@")[1].split(",");
      if (parts.length >= 2) {
        return {
          lat: parseFloat(parts[0]),
          lng: parseFloat(parts[1]),
        };
      }
    }

    // Handle URL with query parameters
    const urlObj = new URL(url);
    const qParam = urlObj.searchParams.get("q");
    if (qParam) {
      const coords = qParam.split(",");
      if (coords.length === 2) {
        return {
          lat: parseFloat(coords[0]),
          lng: parseFloat(coords[1]),
        };
      }
    }

    // Handle URL with /place/ format
    const placeMatch = url.match(/!3d([\d.-]+)!4d([\d.-]+)/);
    if (placeMatch) {
      return {
        lat: parseFloat(placeMatch[1]),
        lng: parseFloat(placeMatch[2]),
      };
    }

    return null;
  } catch (error) {
    console.error(`Error extracting coords from URL ${url}:`, error.message);
    return null;
  }
}

// Distance calculation helper
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

// Format banners for response
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
    };
  });
}

async function getCoordinatesFromPincode(pincode) {
  try {
    // Check cache first
    const cachedCoords = pincodeCache.get(pincode);
    if (cachedCoords) return cachedCoords;

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
      const location = response.data.results[0].geometry.location;
      const coords = { lat: location.lat, lng: location.lng };

      // Cache the result
      pincodeCache.set(pincode, coords);
      return coords;
    }

    return null;
  } catch (error) {
    console.error(`Geocoding failed for pincode ${pincode}:`, error.message);
    return null;
  }
}

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
        description: true,
        validUntil: true,
        rating: true,
      },
    });

    if (offers.length === 0) {
      return res.status(404).json({
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
