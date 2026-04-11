# Salesforce "Account Creation" Integration Plan

This plan outlines the architecture for automatically syncing newly created Schools/Users from your website (via the Central Admin dashboard or public signup flow) directly into **Salesforce** as Accounts and Contacts.

## Goal Description
Currently, when a new school is onboarded, it is created in your database via `prisma.school.create` inside `backend/controllers/central.controller.js`. We want to intercept this event and seamlessly push the mapped data into your Salesforce instance without blocking the user's signup experience.

> [!TIP]
> We will use the officially supported `jsforce` library, which is the industry standard for integrating Node.js with Salesforce APIs. It is lightweight, reliable, and handles authentication cleanly.

---

## Proposed Changes & Architecture

### 1. Pre-requisites: Salesforce Connected App Setup
Before code can be written, we must establish a secure connection pipe to Salesforce:
*   Log into Salesforce Setup.
*   Create a New **Connected App**.
*   Enable OAuth Settings (API access, Offline access).
*   Obtain the **Consumer Key (Client ID)** and **Consumer Secret (Client Secret)**.
*   Setup environment variables in your backend `.env` (e.g., `SF_LOGIN_URL`, `SF_USERNAME`, `SF_PASSWORD`, `SF_TOKEN`, `SF_CLIENT_ID`).

### 2. The Salesforce Service Layer (`services/salesforce.service.js`)
We will create a new isolated service file that encapsulates all Salesforce logic to keep the controllers clean.

#### [NEW] `c:\Users\Jereh Lomak\Desktop\my-projects\skooly\backend\services\salesforce.service.js`
This file will contain functions to:
1.  **Authenticate:** Initialize a `new jsforce.Connection()` using your environment credentials.
2.  **Create Account:** Map the Skooly `School` model to a Salesforce `Account` object (mapping `name`, `address`, `phone`, etc.).
3.  **Create Contact:** Map the Skooly `User` (the Admin who signed up) to a Salesforce `Contact` object (mapping `firstName`, `lastName`, `email`), and tie it to the newly created Account ID.

### 3. Firing the Sync Hook (`controllers/central.controller.js`)
We will hook into your existing signup flow.

#### [MODIFY] `c:\Users\Jereh Lomak\Desktop\my-projects\skooly\backend\controllers\central.controller.js`
Inside the existing function where `prisma.school.create(...)` fires:
```javascript
// Existing Code: Create School & Admin User
const school = await prisma.school.create({ ... });
const admin = await prisma.user.create({ ... });

// [NEW] Fire & Forget Salesforce Sync (Non-Blocking)
// We wrap this in a try-catch so if Salesforce is down, the user's signup doesn't fail.
salesforceService.syncNewSchool(school, admin).catch(err => {
    console.error("Salesforce Sync Failed for School:", school.id, err);
    // Optional: Log this to a failed-job queue (BullMQ/Redis) for automated retries
});
```

---

## Data Mapping Strategy

Salesforce uses standard objects. We will adhere to the following baseline mapping:

| Skooly Entity | Salesforce Object | Mappings |
| :--- | :--- | :--- |
| `School` | **Account** | `School.name` ➔ `Account.Name`<br>`School.address` ➔ `Account.BillingStreet`<br>`School.phone` ➔ `Account.Phone`<br>`Account.Type` ➔ "Customer/School" |
| `Admin User` | **Contact** | `User.name` ➔ `Contact.LastName`<br>`User.email` ➔ `Contact.Email`<br>`User.phone` ➔ `Contact.Phone`<br>`Contact.AccountId` ➔ (ID from above) |

> [!IMPORTANT]
> If your Salesforce instance uses custom fields (e.g., `School_Capacity__c`), we can easily add those to the mapping schema during development.

---

## Open Questions

Before we begin writing the integration code, please confirm the following:

1.  **Authentication:** Do we have access to the Salesforce Admin account right now to create the Connected App and get the API credentials?
2.  **Web-to-Lead vs Direct Sync:** This plan maps the signup directly to an "Account/Contact" (which is best if they just bought/created a real account). If your website is just taking "Demo Requests," we would map it to a "Lead" object instead. Should this be an **Account** or a **Lead**?
3.  **Error Handling:** In the event the Salesforce API is temporarily offline, is a simple server log okay, or do you want to implement a robust Redis retry queue (BullMQ) so no records are ever dropped?

## Verification Plan
*   Setup a Salesforce Developer Sandbox.
*   Create a dummy test school via your central-admin web interface.
*   Verify the node terminal successfully logs the `Account ID` and `Contact ID` dispatched back from Salesforce.
*   Log into the Salesforce dashboard and physically verify the newly minted Account and Contact exist with precisely matched data.
