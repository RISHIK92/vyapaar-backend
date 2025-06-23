/*
  Warnings:

  - You are about to drop the column `Pincode` on the `Listing` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "Pincode",
ADD COLUMN     "pincode" INTEGER;
