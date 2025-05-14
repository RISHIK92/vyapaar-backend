/*
  Warnings:

  - Changed the type of `listingType` on the `Listing` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "listingType",
ADD COLUMN     "listingType" "ListingTier" NOT NULL;
