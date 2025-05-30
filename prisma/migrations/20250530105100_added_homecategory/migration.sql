-- CreateTable
CREATE TABLE "HomeCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "iconName" TEXT,
    "color" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_HomeCategoryToListing" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_HomeCategoryToListing_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "HomeCategory_name_key" ON "HomeCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HomeCategory_slug_key" ON "HomeCategory"("slug");

-- CreateIndex
CREATE INDEX "_HomeCategoryToListing_B_index" ON "_HomeCategoryToListing"("B");

-- AddForeignKey
ALTER TABLE "_HomeCategoryToListing" ADD CONSTRAINT "_HomeCategoryToListing_A_fkey" FOREIGN KEY ("A") REFERENCES "HomeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HomeCategoryToListing" ADD CONSTRAINT "_HomeCategoryToListing_B_fkey" FOREIGN KEY ("B") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
