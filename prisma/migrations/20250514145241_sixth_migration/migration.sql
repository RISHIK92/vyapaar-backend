-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "businessCategory" TEXT,
ADD COLUMN     "establishedYear" INTEGER,
ADD COLUMN     "rating" DOUBLE PRECISION,
ADD COLUMN     "reviewCount" INTEGER,
ADD COLUMN     "serviceArea" TEXT,
ADD COLUMN     "teamSize" TEXT;
