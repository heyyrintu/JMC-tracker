-- CreateTable
CREATE TABLE "capa" (
    "id" SERIAL NOT NULL,
    "discrepancy_id" INTEGER,
    "title" TEXT NOT NULL,
    "root_cause" TEXT,
    "corrective_action" TEXT,
    "preventive_action" TEXT,
    "owner" TEXT,
    "due_date" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "verification_remarks" TEXT,
    "created_by" INTEGER,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_capa_status" ON "capa"("status");
