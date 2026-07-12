-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('FEE', 'ITEM');

-- CreateEnum
CREATE TYPE "FeeCategory" AS ENUM ('TUITION', 'EXAM', 'DEVELOPMENT', 'TRANSPORT', 'BOOKS', 'UNIFORM', 'HOSTEL', 'LUNCH', 'ACTIVITY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StudentTypeScope" AS ENUM ('NEW_INTAKE', 'RETURNING', 'BOTH');

-- CreateEnum
CREATE TYPE "TermScope" AS ENUM ('FIRST_TERM', 'SECOND_TERM', 'THIRD_TERM', 'ANNUAL');

-- CreateEnum
CREATE TYPE "FeeScopeChoice" AS ENUM ('WHOLE_SCHOOL', 'SECTION', 'CLASS', 'STUDENTS');

-- CreateEnum
CREATE TYPE "ScholarshipType" AS ENUM ('SCHOLARSHIP', 'PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "ScholarshipStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransportBillingMode" AS ENUM ('TERMLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "StudentWalletTxType" AS ENUM ('DEPOSIT', 'INVOICE_APPLICATION', 'ADJUSTMENT', 'CARRY_FORWARD', 'OVERPAYMENT_CREDIT');

-- CreateEnum
CREATE TYPE "PaymentEnv" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentTxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'UNDER_REVIEW', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentTxMethod" AS ENUM ('PAYSTACK', 'REMITA', 'BANK_TRANSFER', 'CASH', 'POS', 'WALLET', 'MANUAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TransferSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CLARIFICATION_NEEDED');

-- CreateEnum
CREATE TYPE "StaffAttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'HALF_DAY', 'ABSENT');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "LedgerCategoryType" AS ENUM ('INCOME', 'EXPENSE');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'REMITA';

-- DropIndex
DROP INDEX "AssessmentStructure_schoolId_category_key";

-- DropIndex
DROP INDEX "ClassLevel_name_key";

-- DropIndex
DROP INDEX "CustomRole_name_key";

-- DropIndex
DROP INDEX "GradingScale_schoolId_key";

-- DropIndex
DROP INDEX "TemplateClassAssignment_schoolId_classId_key";

-- AlterTable
ALTER TABLE "AssessmentStructure" ADD COLUMN     "classId" TEXT,
ADD COLUMN     "resultType" TEXT NOT NULL DEFAULT 'SCORE_BASED';

-- AlterTable
ALTER TABLE "CentralAdmin" ADD COLUMN     "resetPasswordExpires" TIMESTAMP(3),
ADD COLUMN     "resetPasswordToken" TEXT;

-- AlterTable
ALTER TABLE "Class" DROP COLUMN "capacity",
ADD COLUMN     "nextTermFee" TEXT,
ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sectionId" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "ClassLevel" ADD COLUMN     "schoolId" TEXT;

-- AlterTable
ALTER TABLE "ClassSubject" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "CustomRole" ADD COLUMN     "schoolId" TEXT;

-- AlterTable
ALTER TABLE "GradingScale" ADD COLUMN     "assessmentType" TEXT NOT NULL DEFAULT 'EXAM',
ADD COLUMN     "category" TEXT DEFAULT 'ALL',
ADD COLUMN     "resultType" TEXT NOT NULL DEFAULT 'SCORE_BASED',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'SUBJECT';

-- AlterTable
ALTER TABLE "ReportTemplate" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'EXAM';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "SchoolSettings" DROP COLUMN "schoolType",
ADD COLUMN     "admissionFormConfig" JSONB,
ADD COLUMN     "admissionLetterTemplate" JSONB,
ADD COLUMN     "blockedFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "caResultMode" TEXT NOT NULL DEFAULT 'NUMERIC',
ADD COLUMN     "currencySymbol" TEXT DEFAULT 'Γéª',
ADD COLUMN     "employmentFormConfig" JSONB,
ADD COLUMN     "employmentLetterTemplate" JSONB,
ADD COLUMN     "examResultMode" TEXT NOT NULL DEFAULT 'NUMERIC',
ADD COLUMN     "issuedResultTypes" TEXT NOT NULL DEFAULT 'BOTH',
ADD COLUMN     "motto" TEXT,
ADD COLUMN     "parentAdmissionRequiresPin" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parentResultAccessMode" TEXT NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "parentTranscriptAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinLifespan" TEXT NOT NULL DEFAULT 'PER_TERM',
ADD COLUMN     "resultAutomaticComments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resultClassPosition" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resultConfig" JSONB,
ADD COLUMN     "resultShowBorder" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resultShowNextTermFees" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resultShowSignature" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resultSubjectPosition" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "schoolTypeId" TEXT,
ADD COLUMN     "smtpFrom" TEXT,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPass" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpUser" TEXT,
ADD COLUMN     "timezone" TEXT DEFAULT 'Africa/Lagos';

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "genotype" TEXT,
ADD COLUMN     "profilePicture" TEXT,
ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "subjectCategoryId" TEXT;

-- AlterTable
ALTER TABLE "StudentReportComment" ADD COLUMN     "absent" INTEGER,
ADD COLUMN     "narrativeComments" JSONB,
ADD COLUMN     "present" INTEGER,
ADD COLUMN     "total" INTEGER;

-- AlterTable
ALTER TABLE "StudentResult" ADD COLUMN     "subjectPosition" INTEGER;

-- AlterTable
ALTER TABLE "Subject" DROP COLUMN "category",
DROP COLUMN "stream",
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "type" TEXT;

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "priceLabel" TEXT;

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "canEnterPastScores" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "photoUrl" TEXT,
ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "staffType" TEXT DEFAULT 'TEACHER';

-- AlterTable
ALTER TABLE "TemplateClassAssignment" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'EXAM';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recoveryKey" TEXT,
ADD COLUMN     "recoveryKeyExpires" TIMESTAMP(3),
ADD COLUMN     "restrictedAt" TIMESTAMP(3),
ADD COLUMN     "restrictedById" TEXT,
ADD COLUMN     "restrictionReason" TEXT;

-- DropEnum
DROP TYPE "SchoolType";

-- DropEnum
DROP TYPE "SubjectCategory";

-- DropEnum
DROP TYPE "SubjectStream";

-- CreateTable
CREATE TABLE "AcademicSession" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademicSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "name" TEXT NOT NULL,
    "shortCode" TEXT,
    "type" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicTerm" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "daysOpened" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "transactionId" TEXT,

    CONSTRAINT "AcademicTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityDeadline" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "label" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "warningLeadHours" INTEGER NOT NULL DEFAULT 48,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityExemption" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "classId" TEXT,
    "subjectId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityExemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentTermEnrollment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "academicTermId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentTermEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectCategory" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "name" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultClasses" JSONB DEFAULT '[]',
    "schoolId" TEXT,

    CONSTRAINT "SchoolType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolLead" (
    "id" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "stateLga" TEXT,
    "preferredPlanId" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyResult" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT,
    "academicYear" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "sessionName" TEXT,
    "fileUrl" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentTermResult" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "average" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentTermResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultTemplate" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "resultType" TEXT NOT NULL DEFAULT 'SCORE_BASED',
    "config" JSONB NOT NULL,
    "assignedSectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResultTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentRule" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "category" TEXT,
    "role" TEXT NOT NULL,
    "resultType" TEXT NOT NULL DEFAULT 'EXAM',
    "minScore" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharingHistory" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectEntryStatus" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "entryType" TEXT NOT NULL DEFAULT 'NUMERIC',
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectEntryStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultReleaseStatus" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "isReleased" BOOLEAN NOT NULL DEFAULT false,
    "resultFormat" TEXT NOT NULL DEFAULT 'SCORE_BASED',
    "visibleTypes" JSONB,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResultReleaseStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraitRating" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "ratings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraitRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraitConfiguration" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'ALL',
    "traits" TEXT[],
    "ratingScale" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraitConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSettings" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL DEFAULT 'Γéª',
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-',
    "receiptPrefix" TEXT NOT NULL DEFAULT 'REC-',
    "allowPartialPayment" BOOLEAN NOT NULL DEFAULT true,
    "allowOverpayment" BOOLEAN NOT NULL DEFAULT false,
    "autoApplyWallet" BOOLEAN NOT NULL DEFAULT false,
    "showOptionalFees" BOOLEAN NOT NULL DEFAULT true,
    "showItemizedBreakdown" BOOLEAN NOT NULL DEFAULT true,
    "financeBranding" JSONB,
    "enableTransport" BOOLEAN NOT NULL DEFAULT false,
    "financeModuleToggles" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeDefinition" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type" "FeeType" NOT NULL DEFAULT 'FEE',
    "category" "FeeCategory" NOT NULL DEFAULT 'TUITION',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantity" INTEGER,
    "studentType" "StudentTypeScope" NOT NULL DEFAULT 'BOTH',
    "scope" "FeeScopeChoice" NOT NULL DEFAULT 'WHOLE_SCHOOL',
    "classIds" TEXT[],
    "termScope" "TermScope" NOT NULL DEFAULT 'ANNUAL',
    "isCompulsory" BOOLEAN NOT NULL DEFAULT true,
    "showOnPortal" BOOLEAN NOT NULL DEFAULT true,
    "allowInstallment" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" TIMESTAMP(3),
    "lateFeeRule" JSONB,
    "discountRule" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "FeeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentFeeAssignment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feeDefinitionId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentFeeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scholarship" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "ScholarshipType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "sponsorName" TEXT,
    "status" "ScholarshipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startTerm" TEXT,
    "startYear" TEXT,
    "endTerm" TEXT,
    "endYear" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Scholarship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportRoute" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "routeName" TEXT NOT NULL,
    "pickupZone" TEXT,
    "priceOneWay" DOUBLE PRECISION NOT NULL,
    "priceReturn" DOUBLE PRECISION NOT NULL,
    "billingMode" "TransportBillingMode" NOT NULL DEFAULT 'TERMLY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "TransportRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentTransportAssignment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "transportMode" TEXT NOT NULL,
    "customPrice" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentTransportAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentWallet" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "studentId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentWalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" "StudentWalletTxType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceBefore" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "auditMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceInvoice" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "studentId" TEXT NOT NULL,
    "term" TEXT,
    "academicYear" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "subTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "walletDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceDue" DOUBLE PRECISION NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FinanceInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceInvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "referenceId" TEXT,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolPaymentSettings" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paystackPublicKey" TEXT,
    "paystackSecretEnc" TEXT,
    "paystackWebhookSecret" TEXT,
    "paystackEnv" "PaymentEnv" NOT NULL DEFAULT 'TEST',
    "paystackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "remitaPublicKey" TEXT,
    "remitaSecretEnc" TEXT,
    "remitaMerchantId" TEXT,
    "remitaWebhookSecret" TEXT,
    "remitaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "merchantDisplayName" TEXT,
    "bankTransferEnabled" BOOLEAN NOT NULL DEFAULT true,
    "transferEvidenceRequired" BOOLEAN NOT NULL DEFAULT true,
    "allowPartialPayment" BOOLEAN NOT NULL DEFAULT true,
    "allowOverpayment" BOOLEAN NOT NULL DEFAULT false,
    "autoApplyWallet" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolPaymentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolBankAccount" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountType" TEXT,
    "notes" TEXT,
    "displayInstructions" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "studentId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PaymentTxStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PaymentTxMethod" NOT NULL,
    "gatewayRef" TEXT,
    "gatewayResponse" JSONB,
    "paidAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "initiatedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "allocatedAmount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferSubmission" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "studentId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderBank" TEXT,
    "transferReference" TEXT,
    "note" TEXT,
    "evidenceUrl" TEXT,
    "evidencePublicId" TEXT,
    "status" "TransferSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceReceipt" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "studentId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "method" "PaymentTxMethod" NOT NULL,
    "invoiceNumbers" TEXT[],
    "walletBalanceAfter" DOUBLE PRECISION,
    "remainingBalanceAfter" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaystackWebhookLog" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "event" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaystackWebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceNotificationLog" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT,
    "type" TEXT NOT NULL,
    "recipient" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QRCode" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "userType" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QRCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAttendance" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "staffId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "checkInTime" TIMESTAMP(3),
    "checkOutTime" TIMESTAMP(3),
    "status" "StaffAttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "markedBy" TEXT NOT NULL DEFAULT 'QR',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceScanLog" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "qrCodeId" TEXT,
    "userId" TEXT NOT NULL,
    "userType" TEXT NOT NULL,
    "scanTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceInfo" TEXT,
    "result" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "AttendanceScanLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannerDevice" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScannerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSettings" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "schoolStartTime" TEXT NOT NULL DEFAULT '08:00',
    "lateThresholdTime" TEXT NOT NULL DEFAULT '08:30',
    "allowMultipleScan" BOOLEAN NOT NULL DEFAULT false,
    "qrEnabled" BOOLEAN NOT NULL DEFAULT true,
    "manualEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoCloseTime" TEXT DEFAULT '17:00',
    "staffCheckOutRequired" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerCategoryType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomeRecord" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "source" "LedgerSource" NOT NULL,
    "referenceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseRecord" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "source" "LedgerSource" NOT NULL,
    "referenceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollSetting" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLoan" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "staffId" TEXT NOT NULL,
    "loanAmount" DOUBLE PRECISION NOT NULL,
    "dateCollected" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repaymentPerMonth" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outstandingBalance" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PensionLedger" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "staffId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payrollRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PensionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "runDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalGross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalNet" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT,
    "expenseRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunItem" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "gross" DOUBLE PRECISION NOT NULL,
    "deductionsBreakdown" JSONB NOT NULL,
    "earningsBreakdown" JSONB NOT NULL,
    "net" DOUBLE PRECISION NOT NULL,
    "paymentMethod" TEXT NOT NULL DEFAULT 'pending',
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "PayrollRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionHistory" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fromClassId" TEXT,
    "toClassId" TEXT,
    "sessionId" TEXT NOT NULL,
    "promotedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROMOTED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "pinId" TEXT NOT NULL,
    "applicationType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "interviewDate" TEXT,
    "interviewTime" TEXT,
    "interviewLocation" TEXT,
    "formData" JSONB NOT NULL,
    "applicantName" TEXT NOT NULL,
    "applicantEmail" TEXT,
    "applicantPhone" TEXT,
    "passportUrl" TEXT,
    "birthCertificateUrl" TEXT,
    "otherCertificatesUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'INFO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademicSession_schoolId_isDeleted_idx" ON "AcademicSession"("schoolId", "isDeleted");

-- CreateIndex
CREATE INDEX "Section_schoolId_isDeleted_idx" ON "Section"("schoolId", "isDeleted");

-- CreateIndex
CREATE INDEX "AcademicTerm_schoolId_isActive_idx" ON "AcademicTerm"("schoolId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicTerm_schoolId_sessionId_name_key" ON "AcademicTerm"("schoolId", "sessionId", "name");

-- CreateIndex
CREATE INDEX "ActivityDeadline_schoolId_isActive_idx" ON "ActivityDeadline"("schoolId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityDeadline_schoolId_termId_activity_key" ON "ActivityDeadline"("schoolId", "termId", "activity");

-- CreateIndex
CREATE INDEX "ActivityExemption_schoolId_termId_userId_idx" ON "ActivityExemption"("schoolId", "termId", "userId");

-- CreateIndex
CREATE INDEX "StudentTermEnrollment_schoolId_idx" ON "StudentTermEnrollment"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentTermEnrollment_studentProfileId_academicTermId_key" ON "StudentTermEnrollment"("studentProfileId", "academicTermId");

-- CreateIndex
CREATE INDEX "SubjectCategory_schoolId_isDeleted_idx" ON "SubjectCategory"("schoolId", "isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolType_schoolId_name_key" ON "SchoolType"("schoolId", "name");

-- CreateIndex
CREATE INDEX "LegacyResult_schoolId_classId_academicYear_idx" ON "LegacyResult"("schoolId", "classId", "academicYear");

-- CreateIndex
CREATE INDEX "LegacyResult_schoolId_studentId_idx" ON "LegacyResult"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "StudentTermResult_schoolId_classId_idx" ON "StudentTermResult"("schoolId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentTermResult_studentProfileId_term_academicYear_key" ON "StudentTermResult"("studentProfileId", "term", "academicYear");

-- CreateIndex
CREATE INDEX "ResultTemplate_schoolId_idx" ON "ResultTemplate"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultTemplate_schoolId_name_key" ON "ResultTemplate"("schoolId", "name");

-- CreateIndex
CREATE INDEX "CommentRule_schoolId_idx" ON "CommentRule"("schoolId");

-- CreateIndex
CREATE INDEX "SharingHistory_schoolId_studentProfileId_idx" ON "SharingHistory"("schoolId", "studentProfileId");

-- CreateIndex
CREATE INDEX "SubjectEntryStatus_schoolId_classId_idx" ON "SubjectEntryStatus"("schoolId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectEntryStatus_schoolId_classId_subjectId_term_academic_key" ON "SubjectEntryStatus"("schoolId", "classId", "subjectId", "term", "academicYear");

-- CreateIndex
CREATE INDEX "ResultReleaseStatus_schoolId_idx" ON "ResultReleaseStatus"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultReleaseStatus_schoolId_classId_term_academicYear_key" ON "ResultReleaseStatus"("schoolId", "classId", "term", "academicYear");

-- CreateIndex
CREATE INDEX "TraitRating_schoolId_classId_idx" ON "TraitRating"("schoolId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "TraitRating_schoolId_studentProfileId_domain_term_academicY_key" ON "TraitRating"("schoolId", "studentProfileId", "domain", "term", "academicYear");

-- CreateIndex
CREATE UNIQUE INDEX "TraitConfiguration_schoolId_domain_category_key" ON "TraitConfiguration"("schoolId", "domain", "category");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSettings_schoolId_key" ON "FinanceSettings"("schoolId");

-- CreateIndex
CREATE INDEX "Scholarship_schoolId_studentId_idx" ON "Scholarship"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "Scholarship_schoolId_isDeleted_idx" ON "Scholarship"("schoolId", "isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "StudentWallet_studentId_key" ON "StudentWallet"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentWalletTransaction_reference_key" ON "StudentWalletTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceInvoice_invoiceNumber_key" ON "FinanceInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolPaymentSettings_schoolId_key" ON "SchoolPaymentSettings"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolBankAccount_schoolId_idx" ON "SchoolBankAccount"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_reference_key" ON "PaymentTransaction"("reference");

-- CreateIndex
CREATE INDEX "PaymentTransaction_schoolId_studentId_idx" ON "PaymentTransaction"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_reference_idx" ON "PaymentTransaction"("reference");

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentTransactionId_idx" ON "PaymentAllocation"("paymentTransactionId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_invoiceId_idx" ON "PaymentAllocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferSubmission_paymentTransactionId_key" ON "TransferSubmission"("paymentTransactionId");

-- CreateIndex
CREATE INDEX "TransferSubmission_schoolId_status_idx" ON "TransferSubmission"("schoolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReceipt_paymentTransactionId_key" ON "FinanceReceipt"("paymentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReceipt_receiptNumber_key" ON "FinanceReceipt"("receiptNumber");

-- CreateIndex
CREATE INDEX "FinanceReceipt_schoolId_idx" ON "FinanceReceipt"("schoolId");

-- CreateIndex
CREATE INDEX "FinanceReceipt_studentId_idx" ON "FinanceReceipt"("studentId");

-- CreateIndex
CREATE INDEX "PaystackWebhookLog_reference_idx" ON "PaystackWebhookLog"("reference");

-- CreateIndex
CREATE INDEX "PaystackWebhookLog_schoolId_idx" ON "PaystackWebhookLog"("schoolId");

-- CreateIndex
CREATE INDEX "FinanceNotificationLog_schoolId_idx" ON "FinanceNotificationLog"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "QRCode_qrToken_key" ON "QRCode"("qrToken");

-- CreateIndex
CREATE INDEX "QRCode_schoolId_userType_userId_idx" ON "QRCode"("schoolId", "userType", "userId");

-- CreateIndex
CREATE INDEX "QRCode_qrToken_idx" ON "QRCode"("qrToken");

-- CreateIndex
CREATE INDEX "StaffAttendance_schoolId_date_idx" ON "StaffAttendance"("schoolId", "date");

-- CreateIndex
CREATE INDEX "StaffAttendance_branchId_idx" ON "StaffAttendance"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAttendance_staffId_date_key" ON "StaffAttendance"("staffId", "date");

-- CreateIndex
CREATE INDEX "AttendanceScanLog_schoolId_scanTime_idx" ON "AttendanceScanLog"("schoolId", "scanTime");

-- CreateIndex
CREATE INDEX "AttendanceScanLog_qrCodeId_idx" ON "AttendanceScanLog"("qrCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "ScannerDevice_token_key" ON "ScannerDevice"("token");

-- CreateIndex
CREATE INDEX "ScannerDevice_schoolId_idx" ON "ScannerDevice"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSettings_schoolId_key" ON "AttendanceSettings"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_schoolId_name_type_key" ON "FinanceCategory"("schoolId", "name", "type");

-- CreateIndex
CREATE INDEX "PayrollSetting_schoolId_staffId_idx" ON "PayrollSetting"("schoolId", "staffId");

-- CreateIndex
CREATE INDEX "StaffLoan_schoolId_staffId_idx" ON "StaffLoan"("schoolId", "staffId");

-- CreateIndex
CREATE INDEX "PensionLedger_schoolId_staffId_idx" ON "PensionLedger"("schoolId", "staffId");

-- CreateIndex
CREATE INDEX "PayrollRun_schoolId_idx" ON "PayrollRun"("schoolId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_payrollRunId_idx" ON "PayrollRunItem"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_staffId_idx" ON "PayrollRunItem"("staffId");

-- CreateIndex
CREATE INDEX "PromotionHistory_schoolId_studentId_idx" ON "PromotionHistory"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_pinId_key" ON "Application"("pinId");

-- CreateIndex
CREATE INDEX "AssessmentStructure_schoolId_category_idx" ON "AssessmentStructure"("schoolId", "category");

-- CreateIndex
CREATE INDEX "ClassLevel_schoolId_idx" ON "ClassLevel"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassLevel_schoolId_name_key" ON "ClassLevel"("schoolId", "name");

-- CreateIndex
CREATE INDEX "CustomRole_schoolId_idx" ON "CustomRole"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_schoolId_name_key" ON "CustomRole"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GradingScale_schoolId_category_type_resultType_assessmentTy_key" ON "GradingScale"("schoolId", "category", "type", "resultType", "assessmentType");

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_publicId_key" ON "StudentProfile"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_publicId_key" ON "TeacherProfile"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateClassAssignment_schoolId_classId_type_key" ON "TemplateClassAssignment"("schoolId", "classId", "type");

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_schoolTypeId_fkey" FOREIGN KEY ("schoolTypeId") REFERENCES "SchoolType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityDeadline" ADD CONSTRAINT "ActivityDeadline_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityExemption" ADD CONSTRAINT "ActivityExemption_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityExemption" ADD CONSTRAINT "ActivityExemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityExemption" ADD CONSTRAINT "ActivityExemption_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityExemption" ADD CONSTRAINT "ActivityExemption_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTermEnrollment" ADD CONSTRAINT "StudentTermEnrollment_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTermEnrollment" ADD CONSTRAINT "StudentTermEnrollment_academicTermId_fkey" FOREIGN KEY ("academicTermId") REFERENCES "AcademicTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTermEnrollment" ADD CONSTRAINT "StudentTermEnrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTermEnrollment" ADD CONSTRAINT "StudentTermEnrollment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_subjectCategoryId_fkey" FOREIGN KEY ("subjectCategoryId") REFERENCES "SubjectCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SubjectCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolType" ADD CONSTRAINT "SchoolType_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolLead" ADD CONSTRAINT "SchoolLead_preferredPlanId_fkey" FOREIGN KEY ("preferredPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyResult" ADD CONSTRAINT "LegacyResult_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyResult" ADD CONSTRAINT "LegacyResult_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyResult" ADD CONSTRAINT "LegacyResult_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSettings" ADD CONSTRAINT "FinanceSettings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeDefinition" ADD CONSTRAINT "FeeDefinition_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeDefinition" ADD CONSTRAINT "FeeDefinition_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeAssignment" ADD CONSTRAINT "StudentFeeAssignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeAssignment" ADD CONSTRAINT "StudentFeeAssignment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeAssignment" ADD CONSTRAINT "StudentFeeAssignment_feeDefinitionId_fkey" FOREIGN KEY ("feeDefinitionId") REFERENCES "FeeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholarship" ADD CONSTRAINT "Scholarship_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scholarship" ADD CONSTRAINT "Scholarship_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportRoute" ADD CONSTRAINT "TransportRoute_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportRoute" ADD CONSTRAINT "TransportRoute_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTransportAssignment" ADD CONSTRAINT "StudentTransportAssignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTransportAssignment" ADD CONSTRAINT "StudentTransportAssignment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentTransportAssignment" ADD CONSTRAINT "StudentTransportAssignment_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWallet" ADD CONSTRAINT "StudentWallet_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWallet" ADD CONSTRAINT "StudentWallet_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWallet" ADD CONSTRAINT "StudentWallet_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWalletTransaction" ADD CONSTRAINT "StudentWalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "StudentWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWalletTransaction" ADD CONSTRAINT "StudentWalletTransaction_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentWalletTransaction" ADD CONSTRAINT "StudentWalletTransaction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceInvoice" ADD CONSTRAINT "FinanceInvoice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceInvoice" ADD CONSTRAINT "FinanceInvoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceInvoice" ADD CONSTRAINT "FinanceInvoice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceInvoiceItem" ADD CONSTRAINT "FinanceInvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FinanceInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolPaymentSettings" ADD CONSTRAINT "SchoolPaymentSettings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolBankAccount" ADD CONSTRAINT "SchoolBankAccount_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolBankAccount" ADD CONSTRAINT "SchoolBankAccount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "FinanceInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferSubmission" ADD CONSTRAINT "TransferSubmission_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferSubmission" ADD CONSTRAINT "TransferSubmission_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferSubmission" ADD CONSTRAINT "TransferSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferSubmission" ADD CONSTRAINT "TransferSubmission_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReceipt" ADD CONSTRAINT "FinanceReceipt_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReceipt" ADD CONSTRAINT "FinanceReceipt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReceipt" ADD CONSTRAINT "FinanceReceipt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReceipt" ADD CONSTRAINT "FinanceReceipt_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceNotificationLog" ADD CONSTRAINT "FinanceNotificationLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QRCode" ADD CONSTRAINT "QRCode_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanLog" ADD CONSTRAINT "AttendanceScanLog_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "QRCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanLog" ADD CONSTRAINT "AttendanceScanLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerDevice" ADD CONSTRAINT "ScannerDevice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettings" ADD CONSTRAINT "AttendanceSettings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeRecord" ADD CONSTRAINT "IncomeRecord_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRecord" ADD CONSTRAINT "ExpenseRecord_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSetting" ADD CONSTRAINT "PayrollSetting_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLoan" ADD CONSTRAINT "StaffLoan_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PensionLedger" ADD CONSTRAINT "PensionLedger_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PensionLedger" ADD CONSTRAINT "PensionLedger_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "TeacherProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionHistory" ADD CONSTRAINT "PromotionHistory_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionHistory" ADD CONSTRAINT "PromotionHistory_fromClassId_fkey" FOREIGN KEY ("fromClassId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionHistory" ADD CONSTRAINT "PromotionHistory_toClassId_fkey" FOREIGN KEY ("toClassId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionHistory" ADD CONSTRAINT "PromotionHistory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_pinId_fkey" FOREIGN KEY ("pinId") REFERENCES "SchoolPin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

