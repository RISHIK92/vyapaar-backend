/*
  Warnings:

  - Added the required column `link` to the `OfferZone` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OfferZone" ADD COLUMN     "link" TEXT NOT NULL;
