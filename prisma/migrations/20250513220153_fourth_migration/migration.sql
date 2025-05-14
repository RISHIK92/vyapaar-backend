/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `Listing` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `Listing` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `listingType` on the `Listing` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropIndex
DROP INDEX "Listing_categoryId_idx";

-- DropIndex
DROP INDEX "Listing_city_idx";

-- DropIndex
DROP INDEX "Listing_listingType_idx";

-- DropIndex
DROP INDEX "Listing_status_idx";

-- DropIndex
DROP INDEX "Listing_userId_idx";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "slug" TEXT NOT NULL,
ALTER COLUMN "price" DROP DEFAULT,
DROP COLUMN "listingType",
ADD COLUMN     "listingType" "ListingType" NOT NULL;

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "listingId" TEXT NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Listing_slug_key" ON "Listing"("slug");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
