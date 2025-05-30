import { Router } from "express";
const router = Router();
import Razorpay from "razorpay";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
import authenticateToken from "../middleware/auth.js";

// Get all categories (for dropdown)
router.get("/all-categories", async (req, res) => {
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
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get home categories
router.get("/", async (req, res) => {
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

// Update home categories (PUT)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.homeCategory.deleteMany({
      where: { id: id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error updating home categories:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add new home category (POST)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { name, categoryId, iconName, color } = req.body;

    // Get current max order to add new item at the end
    const maxOrder = await prisma.homeCategory.aggregate({
      _max: { order: true },
    });

    const newHomeCategory = await prisma.homeCategory.create({
      data: {
        name,
        categoryId,
        iconName: iconName || "Briefcase",
        color: color || "blue",
        order: (maxOrder._max.order || 0) + 1,
      },
      include: {
        category: {
          include: {
            _count: {
              select: { listings: { where: { status: "APPROVED" } } },
            },
          },
        },
      },
    });

    const response = {
      id: newHomeCategory.id,
      name: newHomeCategory.name,
      categoryId: newHomeCategory.categoryId,
      iconName: newHomeCategory.iconName,
      color: newHomeCategory.color,
      order: newHomeCategory.order,
      _count: newHomeCategory.category._count,
    };

    res.status(201).json(response);
  } catch (error) {
    console.error("Error adding home category:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
