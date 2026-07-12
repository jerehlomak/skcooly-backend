// Plain-data mirror of the STAFF sidebar structure in
// client/src/config/menu.tsx — used to seed the Permission catalog.
//
// This is a manually maintained transcription (title/path/children only,
// no icons/roles/permissions) because menu.tsx mixes JSX icon references
// with the data and can't be safely required() from the backend. Keep this
// in sync by hand: a new sidebar item here needs an entry here too, then
// `npm run seed:permissions` to register it as a Permission.
//
// Intentionally excluded: "Log out" (path '/', an action not a page) and
// "WhatsApp" (path '#', a placeholder, not a real route yet).

module.exports = [
    { title: 'Dashboard', path: '/dashboard' },
    {
        title: 'General Settings',
        children: [
            { title: 'School Profile', path: '/dashboard/settings/profile' },
            { title: 'Academic Sections', path: '/dashboard/settings/sections' },
            { title: 'Academic Sessions', path: '/dashboard/settings/academic-sessions' },
            { title: 'Rules & Regulations', path: '/dashboard/settings/rules-regulations' },
            { title: 'Theme & Language', path: '/dashboard/settings/theme-language' },
            { title: 'Account Settings', path: '/dashboard/settings/account-settings' },
            { title: 'Email Setup (SMTP)', path: '/dashboard/settings/smtp-setup' },
            { title: 'Account Recovery', path: '/dashboard/settings/account-recovery' },
        ],
    },
    {
        title: 'Restrictions & Security',
        children: [
            { title: 'Roles & Permissions', path: '/dashboard/settings/role-permissions' },
            { title: 'Activity Deadlines', path: '/dashboard/settings/activity-deadlines' },
            { title: 'Feature Access', path: '/dashboard/settings/feature-access' },
        ],
    },
    {
        title: 'Admission',
        children: [
            { title: 'Admission Applications', path: '/dashboard/admission/applications' },
            { title: 'Admission Form', path: '/dashboard/settings/admission-form' },
            { title: 'Admission Letter', path: '/dashboard/settings/admission-letter' },
            { title: 'CBT Configuration', path: '/dashboard/settings/cbt-settings' },
            { title: 'ID Card Layout', path: '/dashboard/settings/id-card-setup' },
            { title: 'Cards & PINs', path: '/dashboard/pins' },
        ],
    },
    { title: 'ID Card', path: '/dashboard/settings/id-card-setup' },
    {
        title: 'Result Management',
        children: [
            { title: 'Score Entry', path: '/dashboard/results/record' },
            { title: 'Broadsheet & Print', path: '/dashboard/results/admin' },
            { title: 'Export ZIPs', path: '/dashboard/results/export' },
            { title: 'Legacy Results', path: '/dashboard/results/legacy' },
            { title: 'Result Settings', path: '/dashboard/results/settings' },
        ],
    },
    {
        title: 'Classes',
        children: [
            { title: 'All Classes', path: '/dashboard/classes/all' },
            { title: 'Add Class', path: '/dashboard/classes/add-class' },
        ],
    },
    {
        title: 'Subjects',
        children: [
            { title: 'All Subjects', path: '/dashboard/subjects/all' },
            { title: 'Add Subject', path: '/dashboard/subjects/add' },
            { title: 'Subject Categories', path: '/dashboard/settings/subject-categories' },
        ],
    },
    {
        title: 'Academics (AI)',
        children: [
            { title: 'Curriculum & Scheme', path: '/dashboard/academics/curriculum' },
            { title: 'Lesson Notes', path: '/dashboard/academics/lesson-notes' },
            { title: 'CBT Assessments', path: '/teacher/cbt' },
            { title: 'CBT Dashboard', path: '/dashboard/academics/cbt' },
            { title: 'CBT Policies', path: '/dashboard/settings/cbt-policies' },
        ],
    },
    {
        title: 'Students',
        children: [
            { title: 'All Students', path: '/dashboard/students/all' },
            { title: 'Add New', path: '/dashboard/students/add' },
            { title: 'Bulk Import', path: '/dashboard/bulk-import' },
            { title: 'Student ID Cards', path: '/dashboard/students/id-cards' },
            { title: 'Promote Students', path: '/dashboard/students/promote' },
        ],
    },
    {
        title: 'Parents',
        children: [
            { title: 'All Parents', path: '/dashboard/parents/all' },
            { title: 'Add Parent', path: '/dashboard/parents/add' },
        ],
    },
    {
        title: 'Staff',
        children: [
            { title: 'Employment Applications', path: '/dashboard/staff/applications' },
            { title: 'All Staff', path: '/dashboard/employees/all' },
            { title: 'Add Staff', path: '/dashboard/employees/add' },
            { title: 'Employment Form', path: '/dashboard/settings/employment-form' },
            { title: 'Employment Letter', path: '/dashboard/settings/employment-letter' },
            { title: 'Bulk Import', path: '/dashboard/bulk-import' },
            { title: 'Teacher Assignments', path: '/dashboard/academics/assignments' },
        ],
    },
    {
        title: 'Platform Billing',
        children: [
            { title: 'Invoice Inbox', path: '/dashboard/billing/invoices' },
            { title: 'My Wallet', path: '/dashboard/billing/wallet' },
        ],
    },
    {
        title: 'Platform Messages',
        children: [
            { title: 'Messages', path: '/dashboard/platform/messages' },
            { title: 'Communication Templates', path: '/dashboard/messaging/communication-templates' },
        ],
    },
    {
        title: 'Finance',
        children: [
            { title: 'Dashboard', path: '/dashboard/finance/dashboard' },
            { title: 'School Fees', path: '/dashboard/finance/fees' },
            { title: 'Single Billing', path: '/dashboard/finance/single-billing' },
            { title: 'Family Billing', path: '/dashboard/finance/family-billing' },
            { title: 'Scholarships & Discounts', path: '/dashboard/finance/scholarships' },
            {
                title: 'Fees Setup',
                children: [
                    { title: 'Fees Configuration', path: '/dashboard/finance/fees-setup' },
                    { title: 'Fees Particulars', path: '/dashboard/finance/fees-particulars' },
                    { title: 'Custom Fee Rules', path: '/dashboard/finance/custom-fee-rules' },
                    { title: 'Accounts For Fees Invoice', path: '/dashboard/finance/accounts-fees' },
                ],
            },
            {
                title: 'Payment Management',
                children: [
                    { title: 'Invoices', path: '/dashboard/finance/invoices' },
                    { title: 'Payment Records', path: '/dashboard/finance/payments' },
                    { title: 'Transfer Verifications', path: '/dashboard/finance/transfers' },
                    { title: 'Wallet / Ledger', path: '/dashboard/finance/wallet' },
                    { title: 'Payment Settings', path: '/dashboard/finance/payment-settings' },
                ],
            },
            {
                title: 'Income & Expenses',
                children: [
                    { title: 'Income', path: '/dashboard/finance/income-expenses/income' },
                    { title: 'Expenses', path: '/dashboard/finance/income-expenses/expenses' },
                    { title: 'Profit & Loss', path: '/dashboard/finance/income-expenses/profit-loss' },
                    { title: 'Ledger Reports', path: '/dashboard/finance/income-expenses/ledger-reports' },
                    { title: 'Ledger Settings', path: '/dashboard/finance/income-expenses/ledger-settings' },
                ],
            },
            {
                title: 'Payroll',
                children: [
                    { title: 'Payroll Run', path: '/dashboard/finance/payroll/run' },
                    { title: 'Payroll Settings', path: '/dashboard/finance/payroll/settings' },
                    { title: 'Loan Management', path: '/dashboard/finance/payroll/loans' },
                    { title: 'Pension Tracker', path: '/dashboard/finance/payroll/pension' },
                    { title: 'Payslip Generator', path: '/dashboard/finance/payroll/payslip' },
                ],
            },
            { title: 'Inventory', path: '/dashboard/finance/inventory' },
            { title: 'POS', path: '/dashboard/finance/pos' },
            { title: 'Reports', path: '/dashboard/finance/reports' },
            { title: 'Finance Settings', path: '/dashboard/finance/settings' },
        ],
    },
    {
        title: 'Attendance',
        children: [
            { title: 'Dashboard', path: '/dashboard/attendance' },
            { title: 'Student Attendance', path: '/dashboard/attendance/students' },
            { title: 'Staff Attendance', path: '/dashboard/attendance/staff' },
            { title: 'Custom Attendance', path: '/dashboard/attendance/codes' },
            { title: 'QR Management', path: '/dashboard/attendance/qr' },
            { title: 'Scanner Terminal', path: '/dashboard/attendance/scanner' },
            { title: 'Reports', path: '/dashboard/attendance/reports' },
            { title: 'Settings', path: '/dashboard/attendance/settings' },
        ],
    },
    { title: 'Timetable', path: '/dashboard/timetable' },
    { title: 'Homework', path: '/dashboard/homework' },
    { title: 'Behaviour & Skills', path: '/dashboard/behaviour' },
    { title: 'Online Store & POS', path: '/dashboard/store' },
    { title: 'Messaging', path: '/dashboard/messaging' },
    { title: 'SMS Services', path: '/dashboard/sms' },
    { title: 'Live Class', path: '/dashboard/live-class' },
    { title: 'Question Paper', path: '/dashboard/question-paper' },
    { title: 'Exams', path: '/dashboard/exams' },
];
