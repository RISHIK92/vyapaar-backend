-- AlterTable
ALTER TABLE "AdminBanner" ADD COLUMN     "locationUrl" TEXT,
ADD COLUMN     "pincode" INTEGER;

-- AlterTable
ALTER TABLE "Banner" ADD COLUMN     "locationUrl" TEXT,
ADD COLUMN     "pincode" INTEGER;

-- CreateTable
CREATE TABLE "MiddleBanner" (
    "id" SERIAL NOT NULL,
    "Image" TEXT NOT NULL,
    "ListingUrl" TEXT,
    "pincode" INTEGER,
    "locationUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiddleBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BottomBanner" (
    "id" SERIAL NOT NULL,
    "Image" TEXT NOT NULL,
    "ListingUrl" TEXT,
    "pincode" INTEGER,
    "locationUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BottomBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryBanner" (
    "id" SERIAL NOT NULL,
    "Image" TEXT NOT NULL,
    "ListingUrl" TEXT,
    "pincode" INTEGER,
    "locationUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "CategoryBanner_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CategoryBanner" ADD CONSTRAINT "CategoryBanner_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
