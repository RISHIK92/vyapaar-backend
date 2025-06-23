import express from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";
import { uploadFileToS3, deleteFileFromS3 } from "./utils/upload.js";
import multer from "multer";
import homeRouter from "./routes/homeCategories.js";
import authenticateToken from "./middleware/auth.js";
import fs from "fs";

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_URL_ADMIN || "http://localhost:3000",
    credentials: true,
  })
);
app.use("/home-categories", homeRouter);

const calculateExpirationDate = (durationDays) => {
  const date = new Date();
  date.setDate(date.getDate() + durationDays);
  return date;
};

const cleanupRejectedListings = async () => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const oldRejectedListings = await prisma.listing.findMany({
      where: {
        status: "REJECTED",
        updatedAt: { lte: twentyFourHoursAgo },
      },
      select: { id: true },
    });

    const listingIds = oldRejectedListings.map((listing) => listing.id);

    if (listingIds.length > 0) {
      await prisma.$transaction([
        prisma.promotion.deleteMany({
          where: { listingId: { in: listingIds } },
        }),
        prisma.image.deleteMany({
          where: { listingId: { in: listingIds } },
        }),
        prisma.favorite.deleteMany({
          where: { listingId: { in: listingIds } },
        }),
        prisma.adminApproval.deleteMany({
          where: { listingId: { in: listingIds } },
        }),
        prisma.listing.deleteMany({ where: { id: { in: listingIds } } }),
      ]);

      console.log(`Cleaned up ${listingIds.length} rejected listings`);
    }
  } catch (error) {
    console.error("Error cleaning up rejected listings:", error);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"));
    }
  },
});

// Schedule cleanup job to run every hour and at 3am daily
setInterval(cleanupRejectedListings, 60 * 60 * 1000);
cron.schedule("0 3 * * *", cleanupRejectedListings);

// Run immediately on startup
cleanupRejectedListings();

const promoteListingBasedOnTier = async () => {
  try {
    await prisma.promotion.updateMany({
      where: { listingId, isActive: true },
      data: { isActive: false, endDate: new Date() },
    });

    if (listingType === "PREMIUM") {
      await prisma.promotion.create({
        data: {
          listingId,
          price: 0,
          startDate: new Date(),
          duration: "THIRTY_DAYS",
          isActive: true,
        },
      });
    } else if (listingType === "PREMIUM_PLUS") {
      await prisma.promotion.create({
        data: {
          listingId,
          price: 0,
          startDate: new Date(),
          duration: "THIRTY_DAYS",
          isActive: true,
        },
      });
    }
  } catch (error) {
    console.error("Error in automatic promotion:", error);
  }
};

const authenticateAdmin = (requiredPermissions) => {
  return async (req, res, next) => {
    const token = req.cookies.adminToken;

    if (!token) {
      return res.status(401).json({ message: "Admin authentication required" });
    }

    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET_ADMIN || "admin-secret"
      );
      const admin = await prisma.admin.findUnique({
        where: { id: decoded.adminId },
      });

      if (!admin) {
        return res.status(401).json({ message: "Invalid admin token" });
      }

      if (requiredPermissions) {
        const hasPermission = requiredPermissions.some(
          (perm) =>
            admin.permissions.includes(perm) ||
            admin.permissions.includes("SUPER")
        );
        if (!hasPermission) {
          return res.status(403).json({
            message: "Insufficient permissions",
          });
        }
      }

      req.admin = admin;
      next();
    } catch (error) {
      console.error("Admin auth error:", error);
      res.status(401).json({ message: "Invalid or expired token" });
    }
  };
};

// User Routes
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, city } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists with this email",
      });
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

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "7d" }
    );

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

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "7d" }
    );

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

app.post("/auth/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.sameSite,
  });
  res.status(200).json({ message: "Logged out successfully" });
});

app.get("/auth/me", authenticateToken, async (req, res) => {
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
    console.error("Get user error:", error);
    res.status(500).json({ message: "Error fetching user" });
  }
});

// Admin Routes
app.post("/admin/register", async (req, res) => {
  try {
    const { name, email, password, permissions } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        message: "Name, email and password are required",
      });
    }

    const existingAdmin = await prisma.admin.findUnique({ where: { email } });

    if (existingAdmin) {
      return res.status(400).json({
        message: "Admin already exists with this email",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newAdmin = await prisma.admin.create({
      data: {
        name,
        email,
        password: hashedPassword,
        permissions: permissions || ["BASIC"],
      },
    });

    const token = jwt.sign(
      { adminId: newAdmin.id, permissions: newAdmin.permissions },
      process.env.JWT_SECRET_ADMIN || "admin-secret",
      { expiresIn: "1d" }
    );

    res.cookie("adminToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.sameSite,
      maxAge: 24 * 60 * 60 * 1000,
    });

    const { password: _, ...adminData } = newAdmin;
    res.status(201).json({
      message: "Admin registered successfully",
      admin: adminData,
    });
  } catch (error) {
    console.error("Admin registration error:", error);
    res.status(500).json({ message: "Server error during admin registration" });
  }
});

app.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const admin = await prisma.admin.findUnique({ where: { email } });

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const passwordValid = await bcrypt.compare(password, admin.password);
    if (!passwordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { adminId: admin.id, permissions: admin.permissions },
      process.env.JWT_SECRET_ADMIN || "admin-secret",
      { expiresIn: "1d" }
    );

    res.cookie("adminToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.sameSite,
      maxAge: 24 * 60 * 60 * 1000,
    });

    const { password: _, ...adminData } = admin;
    res.status(200).json({
      message: "Admin login successful",
      admin: adminData,
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Server error during admin login" });
  }
});

app.post("/admin/logout", (req, res) => {
  res.clearCookie("adminToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.sameSite,
  });
  res.status(200).json({ message: "Admin logged out successfully" });
});

app.get("/admin/check-auth", authenticateAdmin(), (req, res) => {
  res.status(200).json({
    isAuthenticated: true,
    admin: req.admin,
    permissions: req.admin.permissions,
  });
});

// Listing Routes
app.get("/listings", async (req, res) => {
  try {
    const {
      category,
      city,
      type,
      minPrice,
      maxPrice,
      search,
      page = 1,
      limit = 20,
      sort = "newest",
    } = req.query;

    const where = {
      status: "APPROVED",
    };

    if (category) where.categoryId = category;
    if (city) where.city = { contains: city, mode: "insensitive" };
    if (type) where.type = type;
    if (minPrice) where.price = { gte: parseFloat(minPrice) };
    if (maxPrice) {
      where.price = { ...where.price, lte: parseFloat(maxPrice) };
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { tags: { hasSome: [search] } },
      ];
    }

    const orderBy = {};
    if (sort === "newest") orderBy.createdAt = "desc";
    if (sort === "oldest") orderBy.createdAt = "asc";
    if (sort === "price-high") orderBy.price = "desc";
    if (sort === "price-low") orderBy.price = "asc";

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
        images: {
          take: 1,
          where: { isPrimary: true },
        },
        promotions: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy,
    });

    const total = await prisma.listing.count({ where });

    res.json({
      listings,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get listings error:", error);
    res.status(500).json({ message: "Error fetching listings" });
  }
});

app.get("/listings/featured", async (req, res) => {
  try {
    const featuredListings = await prisma.listing.findMany({
      where: {
        status: "APPROVED",
        promotions: {
          some: {
            isActive: true,
          },
        },
      },
      include: {
        category: true,
        images: {
          take: 1,
          where: { isPrimary: true },
        },
        promotions: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      take: 10,
      orderBy: { createdAt: "desc" },
    });

    res.json(featuredListings);
  } catch (error) {
    console.error("Get featured listings error:", error);
    res.status(500).json({ message: "Error fetching featured listings" });
  }
});

app.get("/listing/:slug", async (req, res) => {
  try {
    // First try to parse as ID (for backward compatibility)
    const id = parseInt(req.params.slug);
    const isIdLookup = !isNaN(id);

    let listing;

    if (isIdLookup) {
      listing = await prisma.listing.findUnique({
        where: { id },
        include: {
          category: true,
          images: true, // Changed from ListingImage to images to match your model
          city: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
          promotions: {
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
          },
          subscription: true,
          Favorite: true,
        },
      });
    } else {
      // Try to find by slug if not a numeric ID
      listing = await prisma.listing.findUnique({
        where: { slug: req.params.slug },
        include: {
          category: true,
          images: true,
          city: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
          promotions: {
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
          },
          subscription: true,
          Favorite: true,
        },
      });
    }

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // Format the response to include all fields
    const response = {
      ...listing,
      // Explicitly include all important fields
      id: listing.id,
      title: listing.title,
      description: listing.description,
      slug: listing.slug,
      type: listing.type,
      price: listing.price,
      negotiable: listing.negotiable,
      tags: listing.tags,
      highlights: listing.highlights,
      businessHours: listing.businessHours,
      phone: listing.phone,
      website: listing.website,
      status: listing.status,
      listingTier: listing.listingTier,
      city: listing.city,
      category: listing.category,
      businessCategory: listing.businessCategory,
      establishedYear: listing.establishedYear,
      serviceArea: listing.serviceArea,
      teamSize: listing.teamSize,
      rating: listing.rating,
      reviewCount: listing.reviewCount,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      expiresAt: listing.expiresAt,
      isBannerEnabled: listing.isBannerEnabled,
      youtubeVideo: listing.youtubeVideo,
      locationUrl: listing.locationUrl,
      pincode: listing.pincode,
      serviceRadius: listing.serviceRadius,
      AdminApproval: listing.AdminApproval,
      images: listing.images,
      user: listing.user,
      promotions: listing.promotions,
      subscription: listing.subscription,
      Favorite: listing.Favorite,
    };

    res.json(response);
  } catch (error) {
    console.error("Get listing error:", error);
    res.status(500).json({ message: "Error fetching listing" });
  }
});

app.post(
  "/admin/upload",
  authenticateToken,
  upload.array("images", 10),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const imageTypes = [];
      for (let i = 0; i < req.files.length; i++) {
        const typeKey = `imageTypes[${i}]`;
        imageTypes.push(req.body[typeKey] || "gallery");
      }

      const uploadPromises = req.files.map((file) => uploadFileToS3(file));
      const uploadedFiles = await Promise.all(uploadPromises);

      const urls = uploadedFiles.map((file, index) => ({
        url: file.url,
        type: imageTypes[index],
        isPrimary: imageTypes[index] === "featured",
        isGallery: imageTypes[index] === "gallery",
        order: index,
      }));

      const primaryImage =
        urls.find((img) => img.isPrimary)?.url || urls[0]?.url;

      res.status(200).json({
        success: true,
        images: urls,
        primaryImage,
        galleryImages: urls
          .filter((img) => img.isGallery)
          .map((img) => img.url),
      });
    } catch (error) {
      console.error("Admin upload error:", error);
      res.status(500).json({ error: "Failed to upload files" });
    }
  }
);

app.post("/admin/listings", authenticateToken, async (req, res) => {
  try {
    const {
      categoryId,
      type,
      title,
      description,
      price,
      negotiable,
      cityId,
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
      photos, // This should be an array of { url, isBanner }
      youtubeVideo,
      locationUrl,
      serviceRadius,
    } = req.body;

    if (!categoryId || !title || !description || !cityId) {
      return res.status(400).json({
        error: "Category, title, description, and city are required",
      });
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

    // Direct approval for admin-created listings
    const initialStatus = "APPROVED";
    const isBannerEnabled = listingTier !== "FREE";

    // Set expiration based on tier (longer durations for admin-created listings)
    let expiresAt;
    if (listingTier === "FREE") {
      expiresAt = calculateExpirationDate(90); // 90 days for FREE
    } else if (listingTier === "PREMIUM") {
      expiresAt = calculateExpirationDate(180); // 180 days for PREMIUM
    } else if (listingTier === "PREMIUM_PLUS") {
      expiresAt = calculateExpirationDate(365); // 1 year for PREMIUM_PLUS
    }

    const newListing = await prisma.listing.create({
      data: {
        title,
        description,
        type: type === "Professional" ? "PROFESSIONAL" : "PRIVATE_INDIVIDUAL",
        price: parseFloat(price) || 0,
        negotiable: negotiable === "true" || negotiable === true,
        category: { connect: { id: categoryId } },
        user: { connect: { id: req.user.userId } },
        city: { connect: { id: cityId } },
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
        listingTier: listingTier,
        status: initialStatus,
        slug,
        expiresAt: expiresAt,
        isBannerEnabled,
        youtubeVideo: youtubeVideo || null,
        locationUrl: locationUrl || null,
        serviceRadius: serviceRadius ? parseInt(serviceRadius) : null,
      },
      include: {
        category: true,
        user: true,
        city: true,
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

    // Create promotion if tier is not FREE
    if (listingTier !== "FREE") {
      const promotionDays = listingTier === "PREMIUM" ? 30 : 60; // 30 days for PREMIUM, 60 for PREMIUM_PLUS
      await prisma.promotion.create({
        data: {
          listingId: newListing.id,
          price: 0, // Admin-created promotions are free
          startDate: new Date(),
          endDate: calculateExpirationDate(promotionDays),
          durationDays: promotionDays,
          isActive: true,
        },
      });
    }

    res.status(201).json({
      message: "Admin listing created and approved successfully",
      listing: newListing,
    });
  } catch (error) {
    console.error("Error creating admin listing:", error);
    res.status(500).json({ error: "Failed to create admin listing" });
  }
});

app.put(
  "/admin/listing/:id",
  authenticateToken,
  upload.array("images"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.userId;

      const {
        title,
        description,
        price,
        negotiable,
        categoryId,
        cityId,
        listingTier,
        type,
        tags = [],
        highlights = [],
        businessHours,
        phone,
        website,
        businessCategory,
        establishedYear,
        serviceArea,
        teamSize,
        youtubeVideo,
        locationUrl,
        pincode,
        serviceRadius,
        imagesToDelete = [],
      } = req.body;

      // Find the listing
      const listing = await prisma.listing.findUnique({
        where: { id: parseInt(id) },
        include: {
          images: true,
          user: true,
          AdminApproval: true,
        },
      });

      if (!listing) {
        return res.status(404).json({
          success: false,
          message: "Listing not found",
        });
      }

      // Authorization check - only owner or admin can edit
      if (listing.userId !== userId) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to edit this listing",
        });
      }

      // Process image deletions first
      if (imagesToDelete.length > 0) {
        // Get the image records to be deleted
        const imagesToRemove = await prisma.image.findMany({
          where: {
            id: { in: imagesToDelete.map((id) => parseInt(id)) },
            listingId: listing.id,
          },
        });

        // Delete from S3 first
        await Promise.all(
          imagesToRemove.map(async (image) => {
            try {
              const fileKey = image.url.split("/").pop();
              await deleteFileFromS3(fileKey);
            } catch (error) {
              console.error(`Error deleting file from S3: ${image.url}`, error);
            }
          })
        );

        // Then delete from database
        await prisma.image.deleteMany({
          where: {
            id: { in: imagesToDelete.map((id) => parseInt(id)) },
            listingId: listing.id,
          },
        });
      }

      // Process new image uploads
      const newImages = [];
      if (req.files && req.files.length > 0) {
        // Upload files to S3 and get URLs
        const uploadResults = await Promise.all(
          req.files.map((file) => uploadFileToS3(file))
        );

        newImages.push(
          ...uploadResults.map((result, index) => ({
            url: result.url,
            isPrimary: index === 0 && listing.images.length === 0,
            listingId: listing.id,
          }))
        );
      }

      // Prepare update data
      const updateData = {
        title,
        description,
        price: parseFloat(price),
        negotiable: negotiable === "true" || negotiable === true,
        categoryId,
        cityId,
        listingTier,
        type,
        tags: Array.isArray(tags)
          ? tags
          : typeof tags === "string"
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t)
          : [],
        highlights: Array.isArray(highlights)
          ? highlights
          : typeof highlights === "string"
          ? highlights
              .split(",")
              .map((h) => h.trim())
              .filter((h) => h)
          : [],
        businessHours: businessHours,
        phone: phone || null,
        website: website || null,
        businessCategory: businessCategory || null,
        establishedYear: establishedYear ? parseInt(establishedYear) : null,
        serviceArea: serviceArea || null,
        teamSize: teamSize || null,
        youtubeVideo: youtubeVideo || null,
        locationUrl: locationUrl || null,
        pincode: pincode ? parseInt(pincode) : null,
        serviceRadius: serviceRadius ? parseInt(serviceRadius) : null,
        updatedAt: new Date(),
      };

      // Update listing with transaction
      const [updatedListing] = await prisma.$transaction([
        prisma.listing.update({
          where: { id: listing.id },
          data: updateData,
          include: {
            images: true,
            city: true,
            category: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
            AdminApproval: true,
          },
        }),
        ...(newImages.length > 0
          ? [
              prisma.image.createMany({
                data: newImages,
              }),
            ]
          : []),
      ]);

      res.json({
        success: true,
        data: updatedListing,
        message: "Listing updated successfully",
      });
    } catch (error) {
      console.error("Error updating listing:", error);

      res.status(500).json({
        success: false,
        message: "Internal server error",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }
);

// Helper function to update review stats
async function updateListingReviewStats(listingId) {
  const stats = await prisma.review.aggregate({
    where: { listingId },
    _avg: { rating: true },
    _count: { id: true },
  });

  await prisma.listing.update({
    where: { id: listingId },
    data: {
      rating: stats._avg.rating,
      reviewCount: stats._count.id,
    },
  });
}

app.delete("/admin/listings/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await prisma.listing.findUnique({
      where: { id: parseInt(id) },
    });

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    if (listing.userId !== req.user.userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to delete this listing" });
    }

    // Delete related records
    await prisma.promotion.deleteMany({ where: { listingId: parseInt(id) } });
    await prisma.image.deleteMany({ where: { listingId: parseInt(id) } });
    await prisma.favorite.deleteMany({ where: { listingId: parseInt(id) } });
    await prisma.payment.deleteMany({ where: { listingId: parseInt(id) } });
    await prisma.adminApproval.deleteMany({
      where: { listingId: parseInt(id) },
    });

    // Delete the listing
    await prisma.listing.delete({ where: { id: parseInt(id) } });

    res.json({ message: "Listing deleted successfully" });
  } catch (error) {
    console.error("Delete listing error:", error);
    res.status(500).json({ message: "Error deleting listing" });
  }
});

// User Listings
app.get("/users/me/listings", authenticateToken, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const where = { userId: req.user.userId };
    if (status) where.status = status;

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
        images: {
          take: 1,
          where: { isPrimary: true },
        },
        promotions: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.listing.count({ where });

    res.json({
      listings,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Get user listings error:", error);
    res.status(500).json({ message: "Error fetching user listings" });
  }
});

// Favorite Routes
app.get("/favorites", authenticateToken, async (req, res) => {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user.userId },
      include: {
        listing: {
          include: {
            category: true,
            images: {
              take: 1,
              where: { isPrimary: true },
            },
          },
        },
      },
    });

    res.json(favorites);
  } catch (error) {
    console.error("Get favorites error:", error);
    res.status(500).json({ message: "Error fetching favorites" });
  }
});

app.post("/favorites", authenticateToken, async (req, res) => {
  try {
    const { listingId } = req.body;

    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const existingFavorite = await prisma.favorite.findFirst({
      where: { userId: req.user.userId, listingId },
    });

    if (existingFavorite) {
      return res.status(400).json({ message: "Listing already in favorites" });
    }

    const favorite = await prisma.favorite.create({
      data: {
        userId: req.user.userId,
        listingId,
      },
    });

    res.status(201).json(favorite);
  } catch (error) {
    console.error("Add favorite error:", error);
    res.status(500).json({ message: "Error adding to favorites" });
  }
});

app.delete("/favorites/:listingId", authenticateToken, async (req, res) => {
  try {
    const { listingId } = req.params;

    const favorite = await prisma.favorite.findFirst({
      where: { userId: req.user.userId, listingId: parseInt(listingId) },
    });

    if (!favorite) {
      return res.status(404).json({ message: "Favorite not found" });
    }

    await prisma.favorite.delete({
      where: { id: favorite.id },
    });

    res.json({ message: "Removed from favorites" });
  } catch (error) {
    console.error("Remove favorite error:", error);
    res.status(500).json({ message: "Error removing from favorites" });
  }
});

// Category Routes
app.get("/categories", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        _count: {
          select: { listings: { where: { status: "APPROVED" } } },
        },
      },
    });

    res.json(categories);
  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({ message: "Error fetching categories" });
  }
});

app.get("/admin/cities", authenticateToken, async (req, res) => {
  try {
    const cities = await prisma.city.findMany({
      include: {
        _count: {
          select: { listings: { where: { status: "APPROVED" } } },
        },
      },
    });

    res.json(cities);
  } catch (error) {
    console.error("Get cities error:", error);
    res.status(500).json({ message: "Error fetching cities" });
  }
});

// Message Routes
app.get("/messages", authenticateToken, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [{ senderId: req.user.userId }, { receiverId: req.user.userId }],
      },
      include: {
        sender: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        receiver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        listing: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(messages);
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({ message: "Error fetching messages" });
  }
});

app.post("/messages", authenticateToken, async (req, res) => {
  try {
    const { receiverId, listingId, content } = req.body;

    if (!receiverId || !content) {
      return res
        .status(400)
        .json({ message: "Receiver and content are required" });
    }

    const message = await prisma.message.create({
      data: {
        senderId: req.user.userId,
        receiverId,
        listingId,
        content,
      },
    });

    res.status(201).json(message);
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ message: "Error sending message" });
  }
});

app.put("/messages/:id/read", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: parseInt(id) },
    });

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.receiverId !== req.user.userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to mark this message as read" });
    }

    const updatedMessage = await prisma.message.update({
      where: { id },
      data: { isRead: true },
    });

    res.json(updatedMessage);
  } catch (error) {
    console.error("Mark message as read error:", error);
    res.status(500).json({ message: "Error marking message as read" });
  }
});

// Search Routes
app.post("/search", async (req, res) => {
  try {
    const { query, filters, userId } = req.body;

    if (userId) {
      await prisma.searchQuery.create({
        data: {
          userId,
          query,
          filters,
        },
      });
    }

    const where = {
      status: "APPROVED",
    };

    if (query) {
      where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { tags: { hasSome: [query] } },
      ];
    }

    if (filters) {
      if (filters.category) where.categoryId = filters.category;
      if (filters.city)
        where.city = { contains: filters.city, mode: "insensitive" };
      if (filters.type) where.type = filters.type;
      if (filters.minPrice) where.price = { gte: parseFloat(filters.minPrice) };
      if (filters.maxPrice) {
        where.price = { ...where.price, lte: parseFloat(filters.maxPrice) };
      }
    }

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
        images: {
          take: 1,
          where: { isPrimary: true },
        },
      },
      take: 20,
    });

    res.json(listings);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ message: "Error performing search" });
  }
});

// Admin Routes
app.get("/admin/listings", authenticateAdmin(), async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
      ];
    }

    const listings = await prisma.listing.findMany({
      where,
      include: {
        category: true,
        images: {
          take: 1,
        },
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        promotions: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.listing.count({ where });

    res.json({
      listings,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Admin listings error:", error);
    res.status(500).json({ message: "Error fetching listings" });
  }
});

app.get("/admin/listings/:id", authenticateAdmin(), async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await prisma.listing.findUnique({
      where: { id: parseInt(id) },
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
          },
        },
        promotions: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
        },
        AdminApproval: true,
      },
    });

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // Format business hours if they exist
    let businessHours = {};
    try {
      businessHours = listing.businessHours
        ? typeof listing.businessHours === "string"
          ? JSON.parse(listing.businessHours)
          : listing.businessHours
        : {};
    } catch (e) {
      console.error("Error parsing business hours", e);
    }

    // Prepare response data
    const responseData = {
      ...listing,
      businessHours,
      lastApproval: listing.AdminApproval?.[0] || null,
    };

    delete responseData.AdminApproval;

    res.json(responseData);
  } catch (error) {
    console.error("Get listing error:", error);
    res.status(500).json({ message: "Error fetching listing" });
  }
});

app.put(
  "/admin/listings/:id/approve",
  authenticateAdmin(["APPROVE_LISTINGS"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { comments } = req.body;

      const listing = await prisma.listing.update({
        where: { id: parseInt(id) },
        data: { status: "APPROVED" },
      });

      await prisma.adminApproval.upsert({
        where: { listingId: parseInt(id) },
        update: {
          adminId: req.admin.id,
          status: "APPROVED",
          comments,
        },
        create: {
          listingId: parseInt(id),
          adminId: req.admin.id,
          status: "APPROVED",
          comments,
        },
      });

      // Automatically promote if listing tier is not FREE
      if (listing.listingTier !== "FREE") {
        await promoteListingBasedOnTier(id, listing.listingTier);
      }

      res.json(listing);
    } catch (error) {
      console.error("Approve listing error:", error);
      res.status(500).json({ message: "Error approving listing" });
    }
  }
);

app.put(
  "/admin/listings/:id/reject",
  authenticateAdmin(["APPROVE_LISTINGS"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { comments } = req.body;

      const listing = await prisma.listing.update({
        where: { id: parseInt(id) },
        data: { status: "REJECTED" },
      });

      await prisma.adminApproval.upsert({
        where: { listingId: parseInt(id) },
        update: {
          adminId: req.admin.id,
          status: "REJECTED",
          comments,
        },
        create: {
          listingId: parseInt(id),
          adminId: req.admin.id,
          status: "REJECTED",
          comments,
        },
      });

      res.json(listing);
    } catch (error) {
      console.error("Reject listing error:", error);
      res.status(500).json({ message: "Error rejecting listing" });
    }
  }
);

app.put(
  "/admin/listings/:id/feature",
  authenticateAdmin(["MANAGE_FEATURED"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { duration = 7 } = req.body;

      await prisma.promotion.updateMany({
        where: { listingId: parseInt(id), isActive: true },
        data: { isActive: false, endDate: new Date() },
      });

      const promotion = await prisma.promotion.create({
        data: {
          listingId: parseInt(id),
          price: 0, // Or get from pricing plan
          startDate: new Date(),
          duration,
          isActive: true,
          durationDays: 0,
        },
      });

      res.json(promotion);
    } catch (error) {
      console.error("Feature listing error:", error);
      res.status(500).json({ message: "Error featuring listing" });
    }
  }
);

app.delete(
  "/listings/:id",
  authenticateAdmin(["DELETE_LISTINGS"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // First delete related records
      await prisma.promotion.deleteMany({ where: { listingId: parseInt(id) } });
      await prisma.image.deleteMany({ where: { listingId: parseInt(id) } });
      await prisma.favorite.deleteMany({ where: { listingId: parseInt(id) } });
      await prisma.adminApproval.deleteMany({
        where: { listingId: parseInt(id) },
      });

      // Then delete the listing
      await prisma.listing.delete({ where: { id: parseInt(id) } });

      res.json({
        message: "Listing and all related data deleted successfully",
      });
    } catch (error) {
      console.error("Delete listing error:", error);
      res.status(500).json({ message: "Error deleting listing" });
    }
  }
);

app.post("/admin/users/register", async (req, res) => {
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

// Admin User Management
app.get("/admin/users", authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;

    const where = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        city: true,
        createdAt: true,
        _count: {
          select: { listings: true, favorites: true },
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.user.count({ where });

    res.json({
      users,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({ message: "Error fetching users" });
  }
});

app.delete("/admin/users/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // First delete user's listings and related data
    const listings = await prisma.listing.findMany({
      where: { userId: parseInt(id) },
      select: { id: true },
    });

    const listingIds = listings.map((l) => l.id);

    await prisma.promotion.deleteMany({
      where: { listingId: { in: listingIds } },
    });
    await prisma.image.deleteMany({
      where: { listingId: { in: listingIds } },
    });
    await prisma.favorite.deleteMany({
      where: { listingId: { in: listingIds } },
    });
    await prisma.adminApproval.deleteMany({
      where: { listingId: { in: listingIds } },
    });
    await prisma.listing.deleteMany({ where: { userId: parseInt(id) } });

    // Then delete the user
    await prisma.user.delete({ where: { id: parseInt(id) } });

    res.json({ message: "User and all related data deleted successfully" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ message: "Error deleting user" });
  }
});

// Pricing Plan Management
app.get("/admin/pricing-plans", authenticateAdmin(), async (req, res) => {
  try {
    const plans = await prisma.pricingPlan.findMany({
      orderBy: { price: "asc" },
    });
    res.json(plans);
  } catch (error) {
    console.error("Pricing plans error:", error);
    res.status(500).json({ message: "Error fetching pricing plans" });
  }
});

app.post(
  "/admin/pricing-plans",
  authenticateAdmin(["MANAGE_PRICING"]),
  async (req, res) => {
    try {
      const { name, description, promotionType, durationType, price } =
        req.body;

      const plan = await prisma.pricingPlan.create({
        data: {
          name,
          description,
          promotionType,
          durationType,
          price,
        },
      });

      res.status(201).json(plan);
    } catch (error) {
      console.error("Create pricing plan error:", error);
      res.status(500).json({ message: "Error creating pricing plan" });
    }
  }
);

app.put(
  "/admin/pricing-plans/:id",
  authenticateAdmin(["MANAGE_PRICING"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        name,
        description,
        promotionType,
        durationType,
        price,
        isActive,
      } = req.body;

      const plan = await prisma.pricingPlan.update({
        where: { id: parseInt(id) },
        data: {
          name,
          description,
          promotionType,
          durationType,
          price,
          isActive,
        },
      });

      res.json(plan);
    } catch (error) {
      console.error("Update pricing plan error:", error);
      res.status(500).json({ message: "Error updating pricing plan" });
    }
  }
);

app.delete(
  "/admin/pricing-plans/:id",
  authenticateAdmin(["MANAGE_PRICING"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      await prisma.pricingPlan.delete({ where: { id: parseInt(id) } });

      res.json({ message: "Pricing plan deleted successfully" });
    } catch (error) {
      console.error("Delete pricing plan error:", error);
      res.status(500).json({ message: "Error deleting pricing plan" });
    }
  }
);

// Category Management
app.get("/admin/categories", authenticateAdmin(), async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        _count: {
          select: { listings: true },
        },
      },
      orderBy: { name: "asc" },
    });
    res.json(categories);
  } catch (error) {
    console.error("Categories error:", error);
    res.status(500).json({ message: "Error fetching categories" });
  }
});

app.post(
  "/admin/categories",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "Category name is required" });
      }

      // Convert name to uppercase
      const uppercaseName = name.toUpperCase();

      const category = await prisma.category.create({
        data: {
          name: uppercaseName,
        },
      });

      res.status(201).json(category);
    } catch (error) {
      console.error("Create category error:", error);
      res.status(500).json({ message: "Error creating category" });
    }
  }
);

app.post(
  "/admin/cities",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "City name is required" });
      }

      // Convert name to uppercase
      const uppercaseName = name.toUpperCase();

      const city = await prisma.city.create({
        data: {
          name: uppercaseName,
        },
      });

      res.status(201).json(city);
    } catch (error) {
      console.error("Create city error:", error);
      res.status(500).json({ message: "Error creating city" });
    }
  }
);

app.put(
  "/admin/categories/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "Category name is required" });
      }

      const uppercaseName = name.toUpperCase();

      const category = await prisma.category.update({
        where: { id: id },
        data: {
          name: uppercaseName,
        },
      });

      res.json(category);
    } catch (error) {
      console.error("Update category error:", error);
      res.status(500).json({ message: "Error updating category" });
    }
  }
);

app.put(
  "/admin/cities/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "City name is required" });
      }

      const uppercaseName = name.toUpperCase();

      const city = await prisma.city.update({
        where: { id: id },
        data: {
          name: uppercaseName,
        },
      });

      res.json(city);
    } catch (error) {
      console.error("Update category error:", error);
      res.status(500).json({ message: "Error updating category" });
    }
  }
);

app.delete(
  "/admin/categories/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check if category has listings
      const listingsCount = await prisma.listing.count({
        where: { categoryId: id },
      });

      if (listingsCount > 0) {
        return res.status(400).json({
          message: "Cannot delete category with active listings",
          listingsCount,
        });
      }

      await prisma.category.delete({ where: { id } });

      res.json({ message: "Category deleted successfully" });
    } catch (error) {
      console.error("Delete category error:", error);
      res.status(500).json({ message: "Error deleting category" });
    }
  }
);

app.delete(
  "/admin/cities/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check if category has listings
      const listingsCount = await prisma.listing.count({
        where: { cityId: id },
      });

      if (listingsCount > 0) {
        return res.status(400).json({
          message: "Cannot delete category with active listings",
          listingsCount,
        });
      }

      await prisma.city.delete({ where: { id } });

      res.json({ message: "Category deleted successfully" });
    } catch (error) {
      console.error("Delete category error:", error);
      res.status(500).json({ message: "Error deleting category" });
    }
  }
);

// Admin Dashboard Stats
app.get("/admin/stats", authenticateAdmin(), async (req, res) => {
  try {
    const [
      usersCount,
      listingsCount,
      pendingListingsCount,
      activePromotionsCount,
      categoriesCount,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.listing.count(),
      prisma.listing.count({ where: { status: "PENDING_APPROVAL" } }),
      prisma.promotion.count({ where: { isActive: true } }),
      prisma.category.count(),
    ]);

    // Recent activity
    const recentListings = await prisma.listing.findMany({
      where: {
        status: "APPROVED",
      },
      take: 5,
      orderBy: { createdAt: "desc" },
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

    const recentUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
      },
    });

    res.json({
      stats: {
        users: usersCount,
        listings: listingsCount,
        pendingListings: pendingListingsCount,
        activePromotions: activePromotionsCount,
        categories: categoriesCount,
      },
      recentActivity: {
        listings: recentListings,
        users: recentUsers,
      },
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ message: "Error fetching dashboard stats" });
  }
});

// Admin Message Management
app.get("/admin/messages", authenticateAdmin(), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const messages = await prisma.message.findMany({
      include: {
        sender: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        receiver: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        listing: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.message.count();

    res.json({
      messages,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Messages error:", error);
    res.status(500).json({ message: "Error fetching messages" });
  }
});

// Admin Promotion Management
app.get("/admin/promotions", authenticateAdmin(), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const where = {};
    if (status === "active") {
      where.isActive = true;
    } else if (status === "expired") {
      where.isActive = false;
    }

    const promotions = await prisma.promotion.findMany({
      where,
      include: {
        listing: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.promotion.count({ where });

    res.json({
      promotions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Promotions error:", error);
    res.status(500).json({ message: "Error fetching promotions" });
  }
});

app.delete(
  "/admin/listings/:id/promotions",
  authenticateAdmin(["MANAGE_PROMOTIONS"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Deactivate all active promotions for this listing
      const result = await prisma.promotion.updateMany({
        where: {
          listingId: parseInt(id),
          isActive: true,
        },
        data: {
          isActive: false,
          endDate: new Date(),
        },
      });

      if (result.count === 0) {
        return res.status(404).json({
          message: "No active promotions found for this listing",
        });
      }

      res.json({
        message: `${result.count} promotion(s) deactivated successfully`,
      });
    } catch (error) {
      console.error("Remove promotions error:", error);
      res.status(500).json({ message: "Error removing promotions" });
    }
  }
);

app.get("/admin/categories", authenticateAdmin(), async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;

    const where = {};
    if (search) {
      where.name = { contains: search, mode: "insensitive" };
    }

    // Get all categories first with their basic info
    const categories = await prisma.category.findMany({
      where,
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
      orderBy: { name: "asc" },
    });

    // Get the counts of approved listings for each category
    const approvedCounts = await Promise.all(
      categories.map(async (category) => {
        const count = await prisma.listing.count({
          where: {
            categoryId: category.id,
            status: "APPROVED",
          },
        });
        return { id: category.id, count };
      })
    );

    // Map the counts back to the categories
    const categoriesWithApprovedCount = categories.map((category) => {
      const countInfo = approvedCounts.find((c) => c.id === category.id);
      return {
        ...category,
        _count: {
          listings: countInfo ? countInfo.count : 0,
        },
      };
    });

    const total = await prisma.category.count({ where });

    res.json({
      categories: categoriesWithApprovedCount,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error("Categories error:", error);
    res.status(500).json({ message: "Error fetching categories" });
  }
});

app.post(
  "/admin/categories",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "Category name is required" });
      }

      const category = await prisma.category.create({
        data: {
          name,
        },
      });

      res.status(201).json(category);
    } catch (error) {
      console.error("Create category error:", error);
      if (error.code === "P2002") {
        return res.status(400).json({ message: "Category already exists" });
      }
      res.status(500).json({ message: "Error creating category" });
    }
  }
);

app.put(
  "/admin/categories/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ message: "Category name is required" });
      }

      const category = await prisma.category.update({
        where: { id: parseInt(id) },
        data: {
          name,
        },
      });

      res.json(category);
    } catch (error) {
      console.error("Update category error:", error);
      if (error.code === "P2002") {
        return res.status(400).json({ message: "Category already exists" });
      }
      res.status(500).json({ message: "Error updating category" });
    }
  }
);

app.delete(
  "/admin/categories/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const listingsCount = await prisma.listing.count({
        where: { categoryId: parseInt(id) },
      });

      if (listingsCount > 0) {
        return res.status(400).json({
          message: "Cannot delete category with active listings",
          listingsCount,
        });
      }

      await prisma.category.delete({ where: { id } });

      res.json({ message: "Category deleted successfully" });
    } catch (error) {
      console.error("Delete category error:", error);
      res.status(500).json({ message: "Error deleting category" });
    }
  }
);

// Admin check auth endpoint
app.get("/admin/check-auth", authenticateAdmin(), (req, res) => {
  res.status(200).json({
    isAuthenticated: true,
    admin: req.admin,
    permissions: req.admin.permissions,
  });
});

app.put(
  "/admin/listings/:id/change-tier",
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { newTier } = req.body;

      // Validate the new tier
      if (!["FREE", "PREMIUM", "PREMIUM_PLUS"].includes(newTier)) {
        return res.status(400).json({ error: "Invalid listing tier" });
      }

      // Find the listing with its current subscription
      const listing = await prisma.listing.findUnique({
        where: { id: parseInt(id) },
        include: {
          subscription: true,
          promotions: {
            where: { isActive: true },
            take: 1,
          },
          images: true,
        },
      });

      if (!listing) {
        return res.status(404).json({ error: "Listing not found" });
      }

      // Calculate new expiration date based on tier change
      let expiresAt = listing.expiresAt;
      const now = new Date();

      // Determine if banner should be enabled
      let isBannerEnabled = listing.isBannerEnabled;

      if (newTier === "FREE") {
        isBannerEnabled = false; // Disable banner for FREE tier
      } else {
        isBannerEnabled = true; // Enable banner for PREMIUM and PREMIUM_PLUS
      }

      if (newTier !== "FREE") {
        // Find the standard subscription for the new tier
        const subscriptionPlan = await prisma.subscriptionPlan.findFirst({
          where: {
            tierType: newTier,
            isActive: true,
          },
          orderBy: { createdAt: "desc" },
        });

        if (subscriptionPlan) {
          // If listing was FREE, set new expiration from now
          if (listing.listingTier === "FREE") {
            expiresAt = new Date();
            expiresAt.setDate(
              expiresAt.getDate() + subscriptionPlan.durationDays
            );
          } else {
            expiresAt = new Date(Math.max(now, new Date(listing.expiresAt)));
            expiresAt.setDate(
              expiresAt.getDate() + subscriptionPlan.durationDays
            );
          }
        }
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
      }

      // Prepare data for update
      const updateData = {
        listingTier: newTier,
        expiresAt,
        isBannerEnabled,
        // If changing to FREE, remove subscription
        subscription: newTier === "FREE" ? { disconnect: true } : undefined,
      };

      // Update the listing
      const updatedListing = await prisma.listing.update({
        where: { id: parseInt(id) },
        data: updateData,
        include: {
          user: true,
          category: true,
          city: true,
          images: true,
          subscription: true,
        },
      });

      // Handle promotion changes
      if (listing.promotions.length > 0) {
        if (newTier === "FREE") {
          // Disable active promotion if changing to FREE
          await prisma.promotion.updateMany({
            where: {
              listingId: parseInt(id),
              isActive: true,
            },
            data: { isActive: false },
          });
        }
      }

      // Handle promotion activation when upgrading from FREE to paid tier
      if (listing.listingTier === "FREE" && newTier !== "FREE") {
        // Find the subscription plan for the new tier
        const subscriptionPlan = await prisma.subscriptionPlan.findFirst({
          where: {
            tierType: newTier,
            isActive: true,
          },
          orderBy: { createdAt: "desc" },
        });

        if (subscriptionPlan && subscriptionPlan.promotionDays > 0) {
          // Create a new promotion when upgrading from FREE to paid tier
          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(startDate.getDate() + subscriptionPlan.promotionDays);

          await prisma.promotion.create({
            data: {
              listingId: parseInt(id),
              price: 0, // Assuming admin-initiated promotions are free
              startDate,
              endDate,
              durationDays: subscriptionPlan.promotionDays,
              isActive: true,
            },
          });
        }
      }

      res.json(updatedListing);
    } catch (error) {
      console.error("Error changing listing tier:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.get("/subscription-plans", async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { price: "asc" },
    });

    res.json(plans);
  } catch (error) {
    console.error("Error fetching subscription plans:", error);
    res.status(500).json({ error: "Failed to fetch subscription plans" });
  }
});

// Get specific subscription plan by ID
app.get("/subscription-plans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: parseInt(id) },
    });

    if (!plan) {
      return res.status(404).json({ error: "Subscription plan not found" });
    }

    res.json(plan);
  } catch (error) {
    console.error("Error fetching subscription plan:", error);
    res.status(500).json({ error: "Failed to fetch subscription plan" });
  }
});

// Admin-only endpoint to create/update subscription plans
app.post("/admin/subscription-plans", authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    const admin = await prisma.admin.findUnique({
      where: { id: req.user.userId },
    });

    if (!admin) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { name, description, durationDays, promotionDays, price, tierType } =
      req.body;

    const newPlan = await prisma.subscriptionPlan.create({
      data: {
        name,
        description,
        durationDays: parseInt(durationDays),
        promotionDays: parseInt(promotionDays),
        price: parseFloat(price),
        tierType,
        adminId: admin.id,
      },
    });

    res.status(201).json(newPlan);
  } catch (error) {
    console.error("Error creating subscription plan:", error);
    res.status(500).json({ error: "Failed to create subscription plan" });
  }
});

// Admin-only endpoint to update subscription plans
app.put(
  "/admin/subscription-plans/:id",
  authenticateToken,
  async (req, res) => {
    try {
      // Check if user is admin
      const admin = await prisma.admin.findUnique({
        where: { id: String(req.user.userId) },
      });

      if (!admin) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const {
        name,
        description,
        durationDays,
        promotionDays,
        price,
        tierType,
        isActive,
      } = req.body;

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: {
          name,
          description,
          durationDays: durationDays ? parseInt(durationDays) : undefined,
          promotionDays: promotionDays ? parseInt(promotionDays) : undefined,
          price: price ? parseFloat(price) : undefined,
          tierType,
          isActive,
          adminId: admin.id,
        },
      });

      res.json(updatedPlan);
    } catch (error) {
      console.error("Error updating subscription plan:", error);
      res.status(500).json({ error: "Failed to update subscription plan" });
    }
  }
);

app.get("/admin/offer-zone", authenticateToken, async (req, res) => {
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

// Admin-only endpoint to create new offers
app.post("/admin/offer-zone", authenticateToken, async (req, res) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: String(req.user.userId) },
    });

    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: Admin access required",
      });
    }

    const {
      vendorName,
      discount,
      promoCode,
      description,
      link,
      validUntil,
      rating,
    } = req.body;

    // Validate required fields
    if (!vendorName || !discount || !validUntil) {
      return res.status(400).json({
        success: false,
        message: "Vendor name, discount, and valid until date are required",
      });
    }

    const newOffer = await prisma.offerZone.create({
      data: {
        vendorName,
        discount,
        promoCode: promoCode || null,
        category: "General",
        description: description || "",
        link: link || "",
        validUntil,
        rating: rating ? parseFloat(rating) : 0.0,
        isActive: true,
      },
    });

    res.status(201).json({
      success: true,
      message: "Offer created successfully",
      data: newOffer,
    });
  } catch (error) {
    console.error("Error creating offer:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while creating offer",
    });
  }
});

// Admin-only endpoint to update offers
app.put("/admin/offer-zone/:id", authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    const admin = await prisma.admin.findUnique({
      where: { id: String(req.user.userId) },
    });

    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: Admin access required",
      });
    }

    const offerId = parseInt(req.params.id);
    if (isNaN(offerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid offer ID",
      });
    }

    const {
      vendorName,
      discount,
      promoCode,
      description,
      link,
      validUntil,
      rating,
      isActive,
    } = req.body;

    // Check if offer exists
    const existingOffer = await prisma.offerZone.findUnique({
      where: { id: offerId },
    });

    if (!existingOffer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found",
      });
    }

    const updatedOffer = await prisma.offerZone.update({
      where: { id: offerId },
      data: {
        vendorName: vendorName || existingOffer.vendorName,
        discount: discount || existingOffer.discount,
        promoCode:
          promoCode !== undefined ? promoCode : existingOffer.promoCode,
        category: existingOffer.category,
        description: description || existingOffer.description,
        validUntil: validUntil || existingOffer.validUntil,
        link: link || existingOffer.link,
        rating:
          rating !== undefined ? parseFloat(rating) : existingOffer.rating,
        isActive:
          isActive !== undefined ? Boolean(isActive) : existingOffer.isActive,
        updatedAt: new Date(),
      },
    });

    res.status(200).json({
      success: true,
      message: "Offer updated successfully",
      data: updatedOffer,
    });
  } catch (error) {
    console.error("Error updating offer:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating offer",
    });
  }
});

// Admin-only endpoint to delete offers
app.delete("/admin/offer-zone/:id", authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    const admin = await prisma.admin.findUnique({
      where: { id: String(req.user.userId) },
    });

    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized: Admin access required",
      });
    }

    const offerId = parseInt(req.params.id);
    if (isNaN(offerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid offer ID",
      });
    }

    // Check if offer exists
    const existingOffer = await prisma.offerZone.findUnique({
      where: { id: offerId },
    });

    if (!existingOffer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found",
      });
    }

    // Soft delete (set isActive to false) or hard delete:
    // Option 1: Soft delete
    // await prisma.offerZone.update({
    //   where: { id: String(offerId) },
    //   data: {
    //     isActive: false,
    //     updatedAt: new Date(),
    //   },
    // });

    // Option 2: Hard delete
    await prisma.offerZone.delete({
      where: { id: offerId },
    });

    res.status(200).json({
      success: true,
      message: "Offer deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting offer:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while deleting offer",
    });
  }
});

// Get all active banners
app.get("/home-banner", async (req, res) => {
  try {
    const banners = await prisma.banner.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

app.get("/home-banner/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const banner = await prisma.banner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    res.json(banner);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banner" });
  }
});

app.post("/home-banner", authenticateToken, async (req, res) => {
  try {
    const { Image, ListingUrl, active = true } = req.body;

    if (!Image) {
      return res.status(400).json({ error: "Image is required" });
    }

    const newBanner = await prisma.banner.create({
      data: {
        Image,
        ListingUrl,
        active,
      },
    });

    res.status(201).json(newBanner);
  } catch (error) {
    res.status(500).json({ error: "Failed to create banner" });
  }
});

app.post(
  "/home-banner/upload",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
      }

      // Upload image to S3
      const uploadResult = await uploadFileToS3(req.file);

      // Create banner record in database
      const { ListingUrl, active = true } = req.body;

      const newBanner = await prisma.banner.create({
        data: {
          Image: uploadResult.url,
          ListingUrl,
          active,
        },
      });

      res.status(201).json(newBanner);
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({
        error: "Failed to upload banner",
        details: error.message,
      });
    }
  }
);

// Update banner (protected)
app.put("/home-banner/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { Image, ListingUrl, active } = req.body;

    const updatedBanner = await prisma.banner.update({
      where: { id: Number(id) },
      data: {
        Image,
        ListingUrl,
        active,
        updatedAt: new Date(),
      },
    });

    res.json(updatedBanner);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to update banner" });
  }
});

app.delete("/home-banner/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await prisma.banner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    const url = new URL(banner.Image);
    const fileKey = url.pathname.substring(1);

    await deleteFileFromS3(fileKey);

    await prisma.banner.delete({
      where: { id: Number(id) },
    });

    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

// Get all admin banners
app.get("/admin-banners", async (req, res) => {
  try {
    const banners = await prisma.adminBanner.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// Get admin banner by ID (protected)
app.get("/admin-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const banner = await prisma.adminBanner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    res.json(banner);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banner" });
  }
});

// Create new admin banner (protected)
app.post("/admin-banners", authenticateToken, async (req, res) => {
  try {
    const {
      Image,
      ListingUrl,
      youtubeUrl,
      pincode,
      locationUrl,
      expiresAt,
      active = true,
    } = req.body;

    // Validate pincode if provided
    if (pincode && (isNaN(pincode) || pincode < 0)) {
      return res.status(400).json({ error: "Invalid pincode format" });
    }

    // Validate expiration date if provided
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      return res
        .status(400)
        .json({ error: "Expiration date must be in the future" });
    }

    const newBanner = await prisma.adminBanner.create({
      data: {
        Image,
        ListingUrl: ListingUrl || null,
        youtubeUrl: youtubeUrl || null,
        pincode: pincode ? Number(pincode) : null,
        locationUrl: locationUrl || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active,
      },
    });

    res.status(201).json(newBanner);
  } catch (error) {
    console.error("Create banner error:", error);
    res.status(500).json({ error: "Failed to create banner" });
  }
});

app.delete("/admin-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await prisma.adminBanner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    const url = new URL(banner.Image);
    const fileKey = url.pathname.substring(1);

    await deleteFileFromS3(fileKey);

    await prisma.adminBanner.delete({
      where: { id: Number(id) },
    });

    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

app.post(
  "/admin-banner/upload",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
      }

      // Upload image to S3
      const uploadResult = await uploadFileToS3(req.file);

      // Create banner record in database
      const {
        ListingUrl,
        active = true,
        locationUrl,
        pincode,
        expiresAt,
      } = req.body;

      const newBanner = await prisma.adminBanner.create({
        data: {
          Image: uploadResult.url,
          ListingUrl,
          locationUrl,
          pincode,
          expiresAt,
          active,
        },
      });

      res.status(201).json(newBanner);
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({
        error: "Failed to upload banner",
        details: error.message,
      });
    }
  }
);

// Update banner (protected)
app.put("/admin-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { Image, ListingUrl, active, locationUrl, pincode, expiresAt } =
      req.body;

    const updatedBanner = await prisma.adminBanner.update({
      where: { id: Number(id) },
      data: {
        Image,
        ListingUrl,
        locationUrl,
        pincode,
        active,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json(updatedBanner);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to update banner" });
  }
});

// Get all middle banners
app.get("/middle-banners", async (req, res) => {
  try {
    const banners = await prisma.middleBanner.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// Create new middle banner (protected)
app.post("/middle-banners", authenticateToken, async (req, res) => {
  try {
    const {
      Image,
      youtubeUrl,
      ListingUrl,
      pincode,
      locationUrl,
      expiresAt,
      active = true,
    } = req.body;

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    // Validate pincode if provided
    if (pincode && (isNaN(pincode) || pincode < 0)) {
      return res.status(400).json({ error: "Invalid pincode format" });
    }

    // Validate YouTube URL format if provided
    if (youtubeUrl) {
      const youtubeRegex =
        /^(https?\:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
      if (!youtubeRegex.test(youtubeUrl)) {
        return res.status(400).json({ error: "Invalid YouTube URL format" });
      }
    }

    // Validate expiration date if provided
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      return res
        .status(400)
        .json({ error: "Expiration date must be in the future" });
    }

    const newBanner = await prisma.middleBanner.create({
      data: {
        Image: Image || null,
        youtubeUrl: youtubeUrl || null,
        ListingUrl: ListingUrl || null,
        pincode: pincode ? Number(pincode) : null,
        locationUrl: locationUrl || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active,
      },
    });

    res.status(201).json(newBanner);
  } catch (error) {
    console.error("Create banner error:", error);
    res.status(500).json({ error: "Failed to create banner" });
  }
});

// Update banner (protected)
app.put("/middle-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Image,
      youtubeUrl,
      ListingUrl,
      active,
      locationUrl,
      pincode,
      expiresAt,
    } = req.body;

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    const updatedBanner = await prisma.middleBanner.update({
      where: { id: Number(id) },
      data: {
        Image,
        youtubeUrl,
        ListingUrl,
        locationUrl,
        pincode,
        active,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json(updatedBanner);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to update banner" });
  }
});

// Upload image (protected)
app.post(
  "/middle-banners/upload",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
      }

      // Upload image to S3
      const uploadResult = await uploadFileToS3(req.file);

      res.status(200).json({
        Image: uploadResult.url,
        message: "Image uploaded successfully",
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({
        error: "Failed to upload image",
        details: error.message,
      });
    }
  }
);

// Delete banner (protected)
app.delete("/middle-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await prisma.middleBanner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    // Delete image from S3 if it exists
    if (banner.Image) {
      const url = new URL(banner.Image);
      const fileKey = url.pathname.substring(1);
      await deleteFileFromS3(fileKey);
    }

    await prisma.middleBanner.delete({
      where: { id: Number(id) },
    });

    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

// Get all bottom banners
app.get("/bottom-banners", async (req, res) => {
  try {
    const banners = await prisma.bottomBanner.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// Create new bottom banner (protected)
app.post("/bottom-banners", authenticateToken, async (req, res) => {
  try {
    const {
      Image,
      youtubeUrl,
      ListingUrl,
      pincode,
      locationUrl,
      expiresAt,
      active = true,
    } = req.body;

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    // Validate pincode if provided
    if (pincode && (isNaN(pincode) || pincode < 0)) {
      return res.status(400).json({ error: "Invalid pincode format" });
    }

    // Validate YouTube URL format if provided
    if (youtubeUrl) {
      const youtubeRegex =
        /^(https?\:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
      if (!youtubeRegex.test(youtubeUrl)) {
        return res.status(400).json({ error: "Invalid YouTube URL format" });
      }
    }

    // Validate expiration date if provided
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      return res
        .status(400)
        .json({ error: "Expiration date must be in the future" });
    }

    const newBanner = await prisma.bottomBanner.create({
      data: {
        Image: Image || null,
        youtubeUrl: youtubeUrl || null,
        ListingUrl: ListingUrl || null,
        pincode: pincode ? Number(pincode) : null,
        locationUrl: locationUrl || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active,
      },
    });

    res.status(201).json(newBanner);
  } catch (error) {
    console.error("Create banner error:", error);
    res.status(500).json({ error: "Failed to create banner" });
  }
});

// Update banner (protected)
app.put("/bottom-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Image,
      youtubeUrl,
      ListingUrl,
      active,
      locationUrl,
      pincode,
      expiresAt,
    } = req.body;

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    const updatedBanner = await prisma.bottomBanner.update({
      where: { id: Number(id) },
      data: {
        Image,
        youtubeUrl,
        ListingUrl,
        locationUrl,
        pincode,
        active,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json(updatedBanner);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to update banner" });
  }
});

// Upload image (protected)
app.post(
  "/bottom-banners/upload",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
      }

      // Upload image to S3
      const uploadResult = await uploadFileToS3(req.file);

      res.status(200).json({
        Image: uploadResult.url,
        message: "Image uploaded successfully",
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({
        error: "Failed to upload image",
        details: error.message,
      });
    }
  }
);

// Delete banner (protected)
app.delete("/bottom-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await prisma.bottomBanner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    // Delete image from S3 if it exists
    if (banner.Image) {
      const url = new URL(banner.Image);
      const fileKey = url.pathname.substring(1);
      await deleteFileFromS3(fileKey);
    }

    await prisma.bottomBanner.delete({
      where: { id: Number(id) },
    });

    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

// Get all category banners
app.get("/category-banners", async (req, res) => {
  try {
    const banners = await prisma.categoryBanner.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    res.json(banners);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// Create new admin banner (protected)
app.post("/category-banners", authenticateToken, async (req, res) => {
  try {
    const {
      Image,
      youtubeUrl,
      categoryId,
      ListingUrl,
      pincode,
      locationUrl,
      expiresAt,
      active = true,
    } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: "Category is required" });
    }

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    // Validate YouTube URL format if provided
    if (youtubeUrl) {
      const youtubeRegex =
        /^(https?\:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
      if (!youtubeRegex.test(youtubeUrl)) {
        return res.status(400).json({ error: "Invalid YouTube URL format" });
      }
    }

    // Validate pincode if provided
    if (pincode && (isNaN(pincode) || pincode < 0)) {
      return res.status(400).json({ error: "Invalid pincode format" });
    }

    // Validate expiration date if provided
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      return res
        .status(400)
        .json({ error: "Expiration date must be in the future" });
    }

    const newBanner = await prisma.categoryBanner.create({
      data: {
        Image: Image || null,
        youtubeUrl: youtubeUrl || null,
        categoryId,
        ListingUrl: ListingUrl || null,
        pincode: pincode ? Number(pincode) : null,
        locationUrl: locationUrl || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        active,
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    res.status(201).json(newBanner);
  } catch (error) {
    console.error("Create banner error:", error);
    res.status(500).json({ error: "Failed to create banner" });
  }
});

// Update banner (protected)
app.put("/category-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Image,
      youtubeUrl,
      categoryId,
      ListingUrl,
      active,
      locationUrl,
      pincode,
      expiresAt,
    } = req.body;

    if (!categoryId) {
      return res.status(400).json({ error: "Category is required" });
    }

    // Validate that either image or youtube URL is provided
    if (!Image && !youtubeUrl) {
      return res
        .status(400)
        .json({ error: "Either image or YouTube URL is required" });
    }

    const updatedBanner = await prisma.categoryBanner.update({
      where: { id: Number(id) },
      data: {
        Image,
        youtubeUrl,
        categoryId,
        ListingUrl,
        locationUrl,
        pincode: pincode ? Number(pincode) : null,
        active,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        updatedAt: new Date(),
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    res.json(updatedBanner);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to update banner" });
  }
});

// Delete banner (protected)
app.delete("/category-banners/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await prisma.categoryBanner.findUnique({
      where: { id: Number(id) },
    });

    if (!banner) {
      return res.status(404).json({ error: "Banner not found" });
    }

    // Delete image from S3 if it exists
    if (banner.Image) {
      const url = new URL(banner.Image);
      const fileKey = url.pathname.substring(1);
      await deleteFileFromS3(fileKey);
    }

    await prisma.categoryBanner.delete({
      where: { id: Number(id) },
    });

    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

app.put(
  "/:bannerType/:id/toggle-status",
  authenticateToken,
  async (req, res) => {
    try {
      const { bannerType, id } = req.params;

      // Validate banner type
      console.log(bannerType);
      const validBannerTypes = [
        "admin-banners",
        "middle-banners",
        "bottom-banners",
        "category-banners",
      ];
      if (!validBannerTypes.includes(bannerType)) {
        return res.status(400).json({ error: "Invalid banner type" });
      }

      // Determine the Prisma model based on banner type
      let prismaModel;
      switch (bannerType) {
        case "admin-banners":
          prismaModel = prisma.adminBanner;
          break;
        case "middle-banners":
          prismaModel = prisma.middleBanner;
          break;
        case "bottom-banners":
          prismaModel = prisma.bottomBanner;
          break;
        case "category-banners":
          prismaModel = prisma.categoryBanner;
          break;
      }

      // Get current status
      const banner = await prismaModel.findUnique({
        where: { id: Number(id) },
      });

      if (!banner) {
        return res.status(404).json({ error: "Banner not found" });
      }

      // Toggle the status
      const updatedBanner = await prismaModel.update({
        where: { id: Number(id) },
        data: {
          active: !banner.active,
          updatedAt: new Date(),
        },
      });

      res.json({
        message: "Banner status updated successfully",
        banner: updatedBanner,
      });
    } catch (error) {
      console.error("Error toggling banner status:", error);
      if (error.code === "P2025") {
        return res.status(404).json({ error: "Banner not found" });
      }
      res.status(500).json({ error: "Failed to update banner status" });
    }
  }
);

app.get("/admin/payment", authenticateToken, async (req, res) => {
  try {
    // Get all payments for listings owned by the authenticated user
    const payments = await prisma.payment.findMany({
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

// GET /admin/pages - List all pages
app.get("/admin/pages", authenticateToken, async (req, res) => {
  try {
    const pages = await prisma.page.findMany({
      orderBy: { updatedAt: "desc" },
    });
    res.json(pages);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch pages" });
  }
});

// POST /admin/pages - Create new page
app.post("/admin/pages", authenticateToken, async (req, res) => {
  const { title, slug, content } = req.body;

  try {
    // Check if page with this slug already exists
    const existingPage = await prisma.page.findUnique({
      where: { slug },
    });

    if (existingPage) {
      return res
        .status(400)
        .json({ error: "Page with this slug already exists" });
    }

    const newPage = await prisma.page.create({
      data: { title, slug, content },
    });

    res.json(newPage);
  } catch (error) {
    res.status(500).json({ error: "Failed to create page" });
  }
});

// PUT /admin/pages/:id - Update page
app.put("/admin/pages/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;

  try {
    const updatedPage = await prisma.page.update({
      where: { id },
      data: { title, content },
    });

    res.json(updatedPage);
  } catch (error) {
    res.status(500).json({ error: "Failed to update page" });
  }
});

// DELETE /admin/pages/:id - Delete page
app.delete("/admin/pages/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.page.delete({
      where: { id },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete page" });
  }
});

app.listen(PORT, () => {
  console.log(PORT);
});
