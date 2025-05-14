import express from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import { upload } from "./utils/upload.js";
import authenticateToken from "./middleware/auth.js";

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: "https://vyapaar-frontend.vercel.app",
    credentials: true,
  })
);

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
        status: "PENDING",
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

      const urls = req.files.map((file) => ({
        url: `/uploads/${file.filename}`,
        filename: file.filename,
      }));

      res.status(200).json({ urls });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to upload files" });
    }
  }
);

app.post(
  "/listings",
  authenticateToken,
  upload.array("photos", 5),
  async (req, res) => {
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
        hidePhone,
        pricingOption,
        businessCategory,
        establishedYear,
        serviceArea,
        teamSize,
        rating,
        reviewCount,
      } = req.body;

      if (!category || !title || !description || !city) {
        return res.status(400).json({
          error: "Category, title, description, city, and email are required",
        });
      }

      let processedHours = {};
      if (businessHours) {
        try {
          processedHours =
            typeof businessHours === "string"
              ? JSON.parse(businessHours)
              : businessHours;
        } catch (e) {
          console.error("Error parsing business hours", e);
        }
      }

      // Find or create category
      let categoryRecord = await prisma.category.findUnique({
        where: { name: category },
      });

      if (!categoryRecord) {
        categoryRecord = await prisma.category.create({
          data: {
            name: category,
            slug: category.toLowerCase().replace(/\s+/g, "-"),
          },
        });
      }

      // Create slug
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

      // Process image URLs
      const imageUrls = req.files
        ? req.files.map((file) => `/uploads/${file.filename}`)
        : [];

      // Process highlights (convert string to array if needed)
      const processedHighlights = Array.isArray(highlights)
        ? highlights
        : typeof highlights === "string" && highlights
        ? highlights
            .split(",")
            .map((h) => h.trim())
            .filter((h) => h)
        : [];

      // Process tags
      const processedTags = Array.isArray(tags)
        ? tags
        : typeof tags === "string" && tags
        ? tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag)
        : [];

      // Create listing
      const newListing = await prisma.listing.create({
        data: {
          title,
          description,
          type: type === "Professional" ? "PROFESSIONAL" : "PRIVATE_INDIVIDUAL",
          price: parseFloat(price) || 0,
          negotiable: negotiable === "true" || negotiable === true,
          city,
          tags: processedTags,
          categoryId: categoryRecord.id,
          userId: req.user.userId,
          highlights: processedHighlights,
          phone: phone || null,
          website: website || null, // Include website
          //   hidePhone: hidePhone === "true" || hidePhone === true,
          businessHours: processedHours,
          businessCategory: businessCategory || null,
          establishedYear: establishedYear ? parseInt(establishedYear) : null,
          serviceArea: serviceArea || null,
          teamSize: teamSize || null,
          rating: rating ? parseFloat(rating) : null,
          reviewCount: reviewCount ? parseInt(reviewCount) : null,
          images: {
            create: imageUrls.map((url, index) => ({
              url,
              isPrimary: index === 0,
            })),
          },
          listingType:
            pricingOption === "TopPage"
              ? "PREMIUM"
              : pricingOption === "TopPageAd"
              ? "LIFETIME_PREMIUM"
              : "FREE",
          slug,
        },
        include: {
          images: true,
          category: true,
        },
      });

      // Handle promotions if needed
      if (pricingOption !== "Free") {
        const promotionType =
          pricingOption === "TopPage" ? "TOP_PAGE_LISTING" : "TOP_PAGE_AD_PLUS";

        const duration =
          pricingOption === "TopPage" ? "SEVEN_DAYS" : "THIRTY_DAYS";

        await prisma.promotion.create({
          data: {
            listingId: newListing.id,
            promotionType,
            price: pricingOption === "TopPage" ? 8.5 : 150,
            startDate: new Date(),
            duration,
            isActive: true,
          },
        });
      }

      res.status(201).json({
        message: "Listing created successfully",
        listing: newListing,
      });
    } catch (error) {
      console.error("Error creating listing:", error);
      res
        .status(500)
        .json({ error: "Failed to create listing", details: error.message });
    }
  }
);

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

    const cities = [
      "New York",
      "Los Angeles",
      "Chicago",
      "Houston",
      "Miami",
      "San Francisco",
      "Seattle",
      "Boston",
      "Denver",
      "Atlanta",
      "Phoenix",
      "Philadelphia",
    ];

    const filteredCities = search
      ? cities.filter((city) =>
          city.toLowerCase().includes(search.toLowerCase())
        )
      : cities.slice(0, 15);

    res.json(filteredCities);
  } catch (error) {
    console.error("Error fetching cities:", error);
    res.status(500).json({ error: "Failed to fetch cities" });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
