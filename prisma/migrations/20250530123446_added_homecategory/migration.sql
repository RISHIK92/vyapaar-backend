/*
  Warnings:

  - Added the required column `name` to the `HomeCategory` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "HomeCategory" ADD COLUMN     "name" TEXT NOT NULL;
