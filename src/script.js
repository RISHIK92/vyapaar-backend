import express from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_URL_ADMIN || "http://localhost:3000",
    credentials: true,
  })
);

// Helper Functions
const generateSlug = () => {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60);
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

const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
    req.user = decoded;
    next();
  } catch (error) {
    console.error("JWT verification error:", error);
    res.status(401).json({ message: "Invalid or expired token" });
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

app.post("/listings", authenticateToken, async (req, res) => {
  try {
    const {
      title,
      description,
      type,
      price,
      negotiable,
      city,
      tags,
      highlights,
      businessHours,
      phone,
      website,
      categoryId,
      listingType,
      businessCategory,
      establishedYear,
      serviceArea,
      teamSize,
      images,
    } = req.body;

    if (!title || !description || !type || !price || !city || !categoryId) {
      return res.status(400).json({ message: "Required fields are missing" });
    }

    const slug = generateSlug(title);
    const existingSlug = await prisma.listing.findUnique({ where: { slug } });

    if (existingSlug) {
      return res.status(400).json({ message: "Title already exists" });
    }

    const listing = await prisma.listing.create({
      data: {
        title,
        description,
        slug,
        type,
        price,
        negotiable,
        city,
        tags,
        highlights,
        businessHours,
        phone,
        website,
        categoryId,
        listingType,
        userId: req.user.userId,
        businessCategory,
        establishedYear,
        serviceArea,
        teamSize,
      },
    });

    // Add images
    if (images && images.length > 0) {
      await prisma.image.createMany({
        data: images.map((img, index) => ({
          url: img,
          listingId: listing.id,
          isPrimary: index === 0,
        })),
      });
    }

    res.status(201).json(listing);
  } catch (error) {
    console.error("Create listing error:", error);
    res.status(500).json({ message: "Error creating listing" });
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
      tags,
      highlights,
      businessHours,
      phone,
      website,
      categoryId,
      listingType,
      businessCategory,
      establishedYear,
      serviceArea,
      teamSize,
      images,
    } = req.body;

    const listing = await prisma.listing.findUnique({
      where: { id: parseInt(id) },
    });

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    if (listing.userId !== req.user.userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to edit this listing" });
    }

    if (listing.status !== "PENDING_APPROVAL") {
      return res
        .status(400)
        .json({ message: "Only pending listings can be edited" });
    }

    const updatedListing = await prisma.listing.update({
      where: { id: parseInt(id) },
      data: {
        title,
        description,
        type,
        price,
        negotiable,
        city,
        tags,
        highlights,
        businessHours,
        phone,
        website,
        categoryId,
        listingType,
        businessCategory,
        establishedYear,
        serviceArea,
        teamSize,
      },
    });

    // Update images
    if (images && images.length > 0) {
      // Delete existing images
      await prisma.image.deleteMany({ where: { listingId: id } });

      // Add new images
      await prisma.image.createMany({
        data: images.map((img, index) => ({
          url: img,
          listingId: id,
          isPrimary: index === 0,
        })),
      });
    }

    res.json(updatedListing);
  } catch (error) {
    console.error("Update listing error:", error);
    res.status(500).json({ message: "Error updating listing" });
  }
});

app.delete("/listings/:id", authenticateToken, async (req, res) => {
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
    await prisma.promotion.deleteMany({ where: { listingId: id } });
    await prisma.image.deleteMany({ where: { listingId: id } });
    await prisma.favorite.deleteMany({ where: { listingId: id } });
    await prisma.adminApproval.deleteMany({ where: { listingId: id } });

    // Delete the listing
    await prisma.listing.delete({ where: { id } });

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
        orderBy: { name: "asc" },
      },
    });

    res.json(categories);
  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({ message: "Error fetching categories" });
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
      const { duration = "SEVEN_DAYS" } = req.body;

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
  "/admin/listings/:id",
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

// Admin User Management
app.get(
  "/admin/users",
  authenticateAdmin(["MANAGE_USERS"]),
  async (req, res) => {
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
  }
);

app.delete(
  "/admin/users/:id",
  authenticateAdmin(["MANAGE_USERS"]),
  async (req, res) => {
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
      await prisma.listing.deleteMany({ where: { userId: id } });

      // Then delete the user
      await prisma.user.delete({ where: { id } });

      res.json({ message: "User and all related data deleted successfully" });
    } catch (error) {
      console.error("Delete user error:", error);
      res.status(500).json({ message: "Error deleting user" });
    }
  }
);

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
        where: { id: parseInt(id) },
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

app.delete(
  "/admin/categories/:id",
  authenticateAdmin(["MANAGE_CATEGORIES"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check if category has listings
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

    const { name, description, durationDays, price, tierType } = req.body;

    const newPlan = await prisma.subscriptionPlan.create({
      data: {
        name,
        description,
        durationDays: parseInt(durationDays),
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
      const { name, description, durationDays, price, tierType, isActive } =
        req.body;

      const updatedPlan = await prisma.subscriptionPlan.update({
        where: { id },
        data: {
          name,
          description,
          durationDays: durationDays ? parseInt(durationDays) : undefined,
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

app.get("/offer-zone", authenticateToken, async (req, res) => {
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

app.listen(3001, () => {
  console.log(3001);
});
