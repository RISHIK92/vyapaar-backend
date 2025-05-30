/*
  Warnings:

  - You are about to drop the column `count` on the `HomeCategory` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `HomeCategory` table. All the data in the column will be lost.
  - You are about to drop the column `slug` on the `HomeCategory` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[categoryId]` on the table `HomeCategory` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `categoryId` to the `HomeCategory` table without a default value. This is not possible if the table is not empty.
  - Added the required column `order` to the `HomeCategory` table without a default value. This is not possible if the table is not empty.
  - Made the column `iconName` on table `HomeCategory` required. This step will fail if there are existing NULL values in that column.
  - Made the column `color` on table `HomeCategory` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "HomeCategory_name_key";

-- DropIndex
DROP INDEX "HomeCategory_slug_key";

-- AlterTable
ALTER TABLE "HomeCategory" DROP COLUMN "count",
DROP COLUMN "name",
DROP COLUMN "slug",
ADD COLUMN     "categoryId" TEXT NOT NULL,
ADD COLUMN     "order" INTEGER NOT NULL,
ALTER COLUMN "iconName" SET NOT NULL,
ALTER COLUMN "color" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "HomeCategory_categoryId_key" ON "HomeCategory"("categoryId");

-- AddForeignKey
ALTER TABLE "HomeCategory" ADD CONSTRAINT "HomeCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
