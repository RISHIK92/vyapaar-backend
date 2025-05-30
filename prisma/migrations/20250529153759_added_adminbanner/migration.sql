-- CreateTable
CREATE TABLE "AdminBanner" (
    "id" SERIAL NOT NULL,
    "Image" TEXT NOT NULL,
    "ListingUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminBanner_pkey" PRIMARY KEY ("id")
);
