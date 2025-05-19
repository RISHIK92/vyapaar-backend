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

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.BACKEND_URL,
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
      sameSite: "lax",
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
      sameSite: "lax",
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
    sameSite: "lax",
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
      sameSite: "lax",
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
      where: { userId: req.user.userId },
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
    console.error("Listings error:", error);
    res.status(500).json({ message: "Error fetching listings" });
  }
});

app.get("/list/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const listing = await prisma.listing.findFirst({
      where: {
        slug: slug,
        status: "APPROVED",
      },
      include: {
        category: true,
        images: true,
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
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
    });

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const similarListings = await prisma.listing.findMany({
      where: {
        categoryId: listing.categoryId,
        status: "APPROVED",
        NOT: {
          id: listing.id,
        },
      },
      take: 4,
      include: {
        images: true,
        promotions: {
          where: {
            isActive: true,
          },
          take: 1,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      listing,
      similarListings,
    });
  } catch (error) {
    console.error("Listing details error:", error);
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
      where.city = location;
    }

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
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
        listingId: id,
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
          listingId: id,
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
        // Use either category connection OR categoryId, not both:
        category: { connect: { id: categoryRecord.id } },
        // Remove this line: categoryId: categoryRecord.id,
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
    // Option 1: Efficient random sampling for large datasets
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

    // Option 2: True random sampling (better for smaller datasets)
    /*
    const allIds = await prisma.listing.findMany({
      where: { status: 'APPROVED' },
      select: { id: true }
    });
    
    const shuffled = allIds.sort(() => 0.5 - Math.random());
    const selectedIds = shuffled.slice(0, 6).map(item => item.id);

    const listings = await prisma.listing.findMany({
      where: { 
        id: { in: selectedIds },
        status: 'APPROVED' 
      },
      include: {
        category: true,
        images: {
          where: { isPrimary: true },
          take: 1
        }
      }
    });
    */

    // Format response
    const formattedListings = listings.map((listing) => ({
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
    }));

    res.json(formattedListings);
  } catch (error) {
    console.error("Error fetching random listings:", error);
    res.status(500).json({
      error: "Failed to fetch random listings",
      details: error.message,
    });
  }
});

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
          {
            subscription: {
              promotionDays: { gt: 0 },
              isActive: true,
            },
          },
        ],
      },
      include: {
        category: true,
        images: {
          where: { isBanner: true },
          take: 1,
        },
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
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
    });

    const formattedBanners = banners.map((listing) => {
      const promotion =
        listing.promotions[0] ||
        (listing.subscription
          ? {
              startDate: listing.createdAt,
              endDate: calculateExpirationDate(
                listing.subscription.promotionDays
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
          listing.city || "your area"
        }`,
        link: `/list/${listing.slug}`,
        promotionType: "STANDARD",
        promotionEndDate: promotion?.endDate,
        isSubscriptionPromotion:
          !listing.promotions.length && !!listing.subscription,
      };
    });

    res.json(formattedBanners);
  } catch (error) {
    console.error("Error fetching banners:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
