-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "daily_entries" (
    "id" SERIAL NOT NULL,
    "work_date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "shift" TEXT DEFAULT 'DAY',
    "notes" TEXT,
    "ppm" INTEGER,
    "created_by" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "approved_by" INTEGER,
    "approved_at" TIMESTAMP(3),
    "jmc_remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manpower_actual" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "approved_count" INTEGER NOT NULL DEFAULT 0,
    "actual_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "manpower_actual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loading" (
    "entry_id" INTEGER NOT NULL,
    "parts_qty" INTEGER NOT NULL DEFAULT 0,
    "manpower_count" INTEGER NOT NULL DEFAULT 0,
    "truck_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "loading_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "unloading" (
    "entry_id" INTEGER NOT NULL,
    "truck_count" INTEGER NOT NULL DEFAULT 0,
    "weight_ton" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "manpower_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "unloading_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "qc" (
    "entry_id" INTEGER NOT NULL,
    "parts_qty" INTEGER NOT NULL DEFAULT 0,
    "manpower_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "qc_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "qc_lines" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "part_no" TEXT,
    "checked_qty" INTEGER NOT NULL DEFAULT 0,
    "rejected_qty" INTEGER NOT NULL DEFAULT 0,
    "rework_qty" INTEGER NOT NULL DEFAULT 0,
    "defect_type" TEXT,
    "remarks" TEXT,

    CONSTRAINT "qc_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdi_parts" (
    "id" SERIAL NOT NULL,
    "part_no" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pdi_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_trips" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "from_loc" TEXT NOT NULL,
    "to_loc" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "trip_time" TEXT,
    "remarks" TEXT,

    CONSTRAINT "transport_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manpower_requests" (
    "id" SERIAL NOT NULL,
    "req_date" TEXT NOT NULL,
    "needed_date" TEXT,
    "category" TEXT NOT NULL,
    "extra_count" INTEGER NOT NULL,
    "reason" TEXT,
    "ppm_current" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMP(3),
    "decision_remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manpower_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" SERIAL NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "caption" TEXT,
    "uploaded_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancies" (
    "id" SERIAL NOT NULL,
    "disc_date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "part_no" TEXT,
    "description" TEXT,
    "qty_dispatched" INTEGER,
    "qty_billed" INTEGER,
    "qr_code" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "raised_by" INTEGER,
    "raised_company" TEXT,
    "resolution" TEXT,
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "qc_entry_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" SERIAL NOT NULL,
    "roll_no" TEXT,
    "name" TEXT NOT NULL,
    "father_name" TEXT,
    "gender" TEXT,
    "dob" TEXT,
    "blood_group" TEXT,
    "mobile" TEXT,
    "address" TEXT,
    "aadhaar" TEXT,
    "pan" TEXT,
    "uan" TEXT,
    "esic_no" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "date_of_joining" TEXT,
    "date_of_exit" TEXT,
    "supervisor" TEXT,
    "wage_type" TEXT DEFAULT 'MONTHLY',
    "monthly_gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "daily_wage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "basic" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hra" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allowances" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pf_applicable" BOOLEAN NOT NULL DEFAULT true,
    "esi_applicable" BOOLEAN NOT NULL DEFAULT true,
    "bank_holder" TEXT,
    "bank_name" TEXT,
    "account_no" TEXT,
    "ifsc" TEXT,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "emergency_relation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "photo" TEXT,
    "onboard_status" TEXT NOT NULL DEFAULT 'APPROVED',
    "submitted_by" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "approved_by" INTEGER,
    "approved_at" TIMESTAMP(3),
    "approval_remarks" TEXT,
    "offer_letter_file" TEXT,
    "offer_letter_at" TIMESTAMP(3),
    "offer_terms" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_documents" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "doc_type" TEXT,
    "doc_slot" TEXT,
    "filename" TEXT NOT NULL,
    "caption" TEXT,
    "expiry_date" TEXT,
    "uploaded_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" SERIAL NOT NULL,
    "work_date" TEXT NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "in_time" TEXT,
    "out_time" TEXT,
    "ot_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "marked_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_applications" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "leave_type" TEXT NOT NULL,
    "from_date" TEXT NOT NULL,
    "to_date" TEXT NOT NULL,
    "days" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "applied_by" INTEGER,
    "decided_by" INTEGER,
    "decided_at" TIMESTAMP(3),
    "decision_remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "idx_sessions_user" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_entries_work_date_key" ON "daily_entries"("work_date");

-- CreateIndex
CREATE INDEX "idx_entries_status" ON "daily_entries"("status");

-- CreateIndex
CREATE INDEX "idx_manpower_entry" ON "manpower_actual"("entry_id");

-- CreateIndex
CREATE INDEX "idx_qclines_entry" ON "qc_lines"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "pdi_parts_part_no_key" ON "pdi_parts"("part_no");

-- CreateIndex
CREATE INDEX "idx_pdiparts_active" ON "pdi_parts"("active");

-- CreateIndex
CREATE INDEX "idx_trips_entry" ON "transport_trips"("entry_id");

-- CreateIndex
CREATE INDEX "idx_disc_date" ON "discrepancies"("disc_date");

-- CreateIndex
CREATE INDEX "idx_disc_status" ON "discrepancies"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workers_roll_no_key" ON "workers"("roll_no");

-- CreateIndex
CREATE INDEX "idx_workers_onboard" ON "workers"("onboard_status");

-- CreateIndex
CREATE INDEX "idx_wdocs_worker" ON "worker_documents"("worker_id");

-- CreateIndex
CREATE INDEX "idx_wdocs_expiry" ON "worker_documents"("expiry_date");

-- CreateIndex
CREATE INDEX "idx_attendance_date" ON "attendance"("work_date");

-- CreateIndex
CREATE INDEX "idx_attendance_worker" ON "attendance"("worker_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_work_date_worker_id_key" ON "attendance"("work_date", "worker_id");

-- CreateIndex
CREATE INDEX "idx_leave_worker" ON "leave_applications"("worker_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_actual" ADD CONSTRAINT "manpower_actual_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading" ADD CONSTRAINT "loading_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unloading" ADD CONSTRAINT "unloading_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc" ADD CONSTRAINT "qc_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_lines" ADD CONSTRAINT "qc_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "daily_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_applications" ADD CONSTRAINT "leave_applications_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
