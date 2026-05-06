# Wellet Privacy Policy

**Effective Date: April 30, 2026**

---

Wellet is a Personal Health Record (PHR) application built for family caregivers — people who are already juggling a lot. This Privacy Policy explains, in plain language, what information we collect when you use Wellet, how we use and protect it, and what choices you have. We've written it to be read, not avoided.

Wellet is operated by Betsy Eble (sole proprietor). When this policy says "Wellet," "we," "us," or "our," it means Betsy Eble operating Wellet.

If you have questions, you can reach us at any time at **privacy@getwellet.com**.

---

## 1. What This Policy Covers

This policy covers information collected through:

- The Wellet web application at [getwellet.com](https://getwellet.com) and [mywellet.com](https://mywellet.com)
- Any emails, forms, or communications you send to us

**What Wellet is — and is not.** Wellet is a standalone Personal Health Record tool designed to help family caregivers organize and stay on top of the health information of the people they care for. Wellet is *not* a healthcare provider, health plan, or health insurance company. Wellet is *not* a "covered entity" under the Health Insurance Portability and Accountability Act (HIPAA).

As the U.S. Department of Health and Human Services (HHS) has explained in [its guidance on PHRs and the HIPAA Privacy Rule](https://www.hhs.gov/sites/default/files/ocr/privacy/hipaa/understanding/special/healthit/phrs.pdf), standalone PHR tools offered directly to individuals by vendors who are not covered entities fall *outside* the scope of the HIPAA Privacy Rule. Wellet falls into that category. The information you store in Wellet is governed by this Privacy Policy, applicable state laws, and the [FTC's Health Breach Notification Rule](https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule) — not by HIPAA.

This also means we won't make misleading claims about being "HIPAA-compliant" where that standard doesn't apply. What we *do* commit to is handling your family's health information with honesty, care, and strong security practices.

---

## 2. Information We Collect

We only collect information that helps Wellet work for you. Here's exactly what that includes:

### Account Information
- **Email address** — used to sign you in via a magic link (a one-time login link sent to your inbox). We do not store passwords.

### Care Recipient Profiles
When you create a profile for the person you care for, you may enter:
- Name and date of birth
- Your relationship to them
- Medical conditions and allergies
- Blood type
- Insurance information
- Emergency contacts
- Medications
- Primary care physician information

This information is entirely optional and controlled by you. You decide what to add and what to leave out.

### Health Events and Records
- Appointments, medications, lab results, vitals, and notes you enter manually
- Health record data you import from EHR exports (such as MyChart ZIP files or PDF summaries)
- Discharge summaries, medication photos, and other documents you upload

### AI Conversation Data
- Questions and prompts you submit to **Ask Wellet** (our AI health Q&A feature)
- AI-generated health summaries produced by **Update Me**

See [Section 4](#4-ai-powered-features-and-data-processing) for important details on how AI features work and where this data goes.

### Care Circle Information
When you invite other caregivers to share access to a care recipient's record, we collect:
- Names, email addresses, and phone numbers of the people you invite

### SMS / Text Messaging
When you invite a family member or loved one through **Wellet Connect**, the phone number you enter is used solely to send a one-time invitation SMS, and an optional reminder if the invitation is not accepted. SMS delivery is handled by our messaging vendor, **Twilio**. We do not sell, rent, or share these phone numbers with third parties for marketing. Recipients can reply **STOP** at any time to opt out, and **HELP** for support. Standard carrier message and data rates may apply. See the [SMS Messaging Terms](/terms#19-sms-messaging-terms) for full details.

### Feedback
- Messages you send through in-app feedback forms

### Waitlist and Marketing
- Email address and interest level submitted through our waitlist or marketing forms

### Usage Data
- Standard web analytics (pages visited, features used, general usage patterns) to help us improve the product. We do not use third-party tracking pixels or advertising networks.

---

## 3. How We Use Your Information

We use the information you provide to:

- **Operate Wellet** — store and display the health records and profiles you create
- **Authenticate your account** — send you magic links so you can sign in securely
- **Deliver AI features** — process your questions through Ask Wellet and generate health summaries with Update Me (see Section 4)
- **Enable Care Circle** — share the appropriate records with caregivers you invite
- **Send transactional emails** — account confirmations, magic links, security notices
- **Send marketing emails** — only if you've signed up for our mailing list, and only about Wellet updates or features (you can unsubscribe at any time)
- **Improve the product** — aggregate, anonymized usage analytics to understand how people use Wellet and where we can do better
- **Respond to support requests** — reply to questions or feedback you send us

We do **not** use your health information for advertising, and we do **not** use it for any transaction that could involve money or money-equivalents (such as targeted advertising or lead generation). We do **not** sell your data. Ever.

### Impact of Sharing on Others

Some health information is inherently about more than one person. Family medical history, genetic conditions, and hereditary diagnoses can reveal things about a care recipient's relatives — including people who have not used Wellet. When you enter, import, or share information of this kind, please consider who else might be affected. We encourage you to share Wellet access and exported records thoughtfully, and only with people the care recipient (or their legal representative) would want to have that information.

---

## 4. AI-Powered Features and Data Processing

Wellet includes two AI-powered features:

- **Ask Wellet** — a conversational assistant where you can ask health-related questions in context of your loved one's records
- **Update Me** — an AI-generated health summary based on the care recipient's profile and recent health events

### How AI Processing Works

When you use Ask Wellet or Update Me, Wellet sends relevant health information — which may include names, conditions, medications, and health events from the care recipient's profile — to [OpenAI's API](https://openai.com) for processing. OpenAI returns a response, which Wellet displays to you. We store the questions you ask and the AI-generated responses in your Wellet account.

### Important Disclosure: No BAA with OpenAI

We want to be transparent with you: **Wellet does not currently have a Business Associate Agreement (BAA) with OpenAI.** A BAA is a contract used under HIPAA to govern how a service provider handles protected health information. Because Wellet is not a HIPAA-covered entity, we are not required to maintain a BAA. However, we recognize this is meaningful information for many caregivers.

What this means in practice: health data you submit through Ask Wellet or Update Me is processed by OpenAI under [OpenAI's standard API terms and privacy policy](https://openai.com/policies/privacy-policy), not under a healthcare-specific BAA. We encourage you to review OpenAI's privacy practices if this is important to your decision about using these features.

You can use Wellet's core record-keeping features — entering health events, managing profiles, uploading documents — without using Ask Wellet or Update Me.

### Future Integrations

We plan to offer direct EHR connections through **1upHealth** (a FHIR API service), which would allow you to import records directly from healthcare providers. We will update this policy before enabling that integration.

---

## 5. How We Store and Protect Your Information

We take security seriously. Here's how your information is protected:

### Cloud Infrastructure
Wellet's database is hosted on [Supabase](https://supabase.com), which runs on Amazon Web Services (AWS). Supabase serves as our infrastructure provider and data processor.

### Encryption
- **In transit:** All data between your browser and Wellet is encrypted using TLS/SSL
- **At rest:** All data stored in our database is encrypted using AES-256 encryption (provided by Supabase and AWS)

### Access Controls
- We use **Row-Level Security (RLS)** on all 18 database tables, which means the database enforces that each user can only access their own data — even at the infrastructure level
- Documents (uploaded files, PDFs, images) are stored in private Supabase Storage buckets with user-scoped access policies, so only you (and caregivers you've explicitly invited) can access them
- Authentication is handled through **Supabase Auth** using magic links — no passwords are stored

### Session Security
- A **15-minute inactivity timeout** automatically clears your session
- **No health data is stored on your device** beyond your active browser session

### Our Website
The Wellet marketing website is hosted on [Netlify](https://netlify.com). No personal health information is stored on or processed by Netlify.

### Our Commitments from Third-Party Vendors
We only use third-party vendors and contractors who are **contractually bound to the same commitments we make to you in this Privacy Policy**. That means any vendor we rely on to operate Wellet (see the table in Section 6) is required, through our agreements with them, to protect your data, use it only for the purposes we authorize, and meet the same baseline standards around confidentiality, security, and non-disclosure that we follow. We do not engage vendors who are unwilling to accept those terms.

---

## 6. Information Sharing and Third Parties

We share your information only as necessary to operate Wellet. Here's the complete picture:

| Service | What They Receive | Why |
|---|---|---|
| **Supabase** | All account and health data | Database and file storage infrastructure |
| **OpenAI** | Health data submitted via Ask Wellet / Update Me | AI feature processing |
| **Netlify** | No personal health information | Hosts our marketing website only |
| **Mailchimp** | Email address only (no health data) | Marketing emails to people who opt in |
| **Twilio** | Phone numbers entered into Wellet Connect (no health data) | Sends invitation and reminder SMS to family members and loved ones |

**We do not:**
- Sell your personal information to anyone, ever
- Share your health data with advertisers
- Use tracking pixels or ad networks
- Share data with data brokers

**No third-party use without your explicit consent.** Third-party use or disclosure of your information — including any de-identified, anonymized, or pseudonymized versions of it — is prohibited without your explicit consent. The only exceptions are the vendors listed above that are necessary to operate Wellet on your behalf, and disclosures required by law.

We may disclose information if required by law (such as a valid court order or government subpoena), but we will notify you to the extent we are legally permitted to do so before complying.

---

## 7. Your Rights and Choices

You are in control of your data. Here's what you can do at any time:

- **View your data** — all health records, profiles, and AI conversations are accessible in your Wellet account
- **Export your data** — download a complete archive of your health records (PDF + structured data) from your account settings
- **Delete records** — remove individual health events, documents, or entire care recipient profiles
- **Revoke Care Circle access** — remove any caregiver's access to a care recipient's record instantly from your settings
- **Unsubscribe from marketing** — every marketing email includes an unsubscribe link, and you can opt out at any time
- **Delete your account** — see Section 8 for full details

To exercise any of these rights, or if you have questions, contact us at **privacy@getwellet.com**.

---

## 8. Data Retention and Deletion

### While Your Account Is Active
We retain your data for as long as your account is active, so Wellet can function as your ongoing health record.

### Deleting Your Account
You can request permanent deletion of your data at any time from your account settings, or by emailing **privacy@getwellet.com** with "Delete my account" in the subject line. When you request account deletion:

1. Your account enters a **30-day grace period** — your data remains intact but inaccessible during this window, in case you change your mind
2. After the grace period, **100% of your data is permanently and irreversibly deleted within 45 days of your original request** — this includes your account information, all care recipient profiles, health events, uploaded documents, AI conversation history, Care Circle records, **and any data imported from non-VA sources** (such as MyChart exports, PDFs, or other EHR imports)

There is no partial deletion. When you go, everything goes with you — VA and non-VA data alike.

### Inactive Accounts
We do not currently have an automated policy for deleting inactive accounts, but we may implement one with advance notice.

### Backups
Residual copies of data may persist in encrypted database backups for a short period following deletion. These backups are not accessible or used for any purpose other than disaster recovery, and they are purged on a rolling schedule.

---

## 9. Children's Privacy

Wellet is designed for adult family caregivers and is not intended for use by children under 18 years of age. We do not knowingly collect personal information from anyone under 18. If you believe a minor has created an account, please contact us at **privacy@getwellet.com** and we will promptly delete the account.

---

## 10. California Privacy Rights (CCPA/CPRA)

If you are a California resident, the California Consumer Privacy Act (CCPA) and California Privacy Rights Act (CPRA) give you additional rights regarding your personal information.

### Your California Rights

- **Right to Know** — You can request details about the categories and specific pieces of personal information we've collected about you, and how we've used or disclosed it
- **Right to Delete** — You can request that we delete your personal information (subject to limited exceptions)
- **Right to Correct** — You can request that we correct inaccurate personal information
- **Right to Opt Out of Sale or Sharing** — We do not sell or share your personal information for cross-context behavioral advertising. There is nothing to opt out of.
- **Right to Limit Use of Sensitive Personal Information** — We use sensitive personal information (including health data) only to provide Wellet's core services to you
- **Right to Non-Discrimination** — We will not discriminate against you for exercising any of these rights

### Categories of Personal Information Collected

In the past 12 months, we have collected the following categories of personal information as defined by the CCPA: identifiers (email address, name), personal records (health and medical information, insurance details), internet or other electronic network activity (usage analytics), and inferences drawn from personal information (AI-generated health summaries).

### How to Submit a California Privacy Request

To exercise your California rights, contact us at **privacy@getwellet.com** with "California Privacy Request" in the subject line. We will respond within 45 calendar days. We may need to verify your identity before processing your request.

---

## 11. Breach Notification

Wellet is a vendor of personal health records subject to the [FTC's Health Breach Notification Rule](https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule) (16 CFR Part 318), as updated by the [FTC's 2024 final rule](https://www.ftc.gov/business-guidance/blog/2024/04/updated-ftc-health-breach-notification-rule-puts-new-provisions-place-protect-users-health-apps). We are also subject to Section 5 of the FTC Act, which prohibits unfair or deceptive practices.

If we discover a breach of unsecured health information, we will:

1. **Notify affected users within 72 hours** of discovering the breach — by email and/or in-app notification — describing what happened, what types of information were involved, and what we are doing about it
2. **Notify the FTC** as required (within 60 calendar days, or simultaneously with user notification for breaches affecting 500 or more people)
3. **Notify media outlets** if required for breaches affecting 500 or more residents of a state

A "breach" under the FTC's rule includes unauthorized access, inadvertent disclosure, and any unauthorized acquisition of your health information — not just malicious hacks.

---

## 12. Changes to This Policy and Changes in Ownership

### Updates to This Policy
We may update this Privacy Policy from time to time. When we make material changes, we will:

- Post the updated policy at [getwellet.com/privacy](https://getwellet.com/privacy)
- Update the effective date at the top of this document
- Send you an email notification if the changes are significant

Your continued use of Wellet after changes are posted constitutes your acceptance of the updated policy. If you do not agree, you can delete your account.

### Transfer of Ownership, Merger, Sale, or Bankruptcy
If Wellet ever enters into a transfer of ownership, merger, acquisition, sale of assets, joint venture, assignment, or bankruptcy proceeding, your data may be transferred as part of that transaction. If that happens, we commit to the following:

- **Advance notice.** We will notify you by email and in-app notification before any change in ownership takes effect, so you have time to decide what you want to do with your data.
- **Your options.** Before the transfer occurs, you will be able to:
  - Securely export, download, or transmit your health information to yourself or another recipient of your choice
  - Require that the new owner or entity honor this Privacy Policy (or a policy that is at least as protective) going forward
  - Close your account and have your data permanently deleted under the same terms as Section 8
- **Consistent commitments.** Any new owner will be contractually required to handle your data under privacy and security commitments that are consistent with this policy, or to give you the chance to delete your account before accepting new terms.

---

## 13. Contact Us

We're a small team and we take privacy seriously. If you have questions about this policy, want to exercise your rights, or just want to understand how your data is handled, please reach out.

**Wellet (operated by Betsy Eble)**
Email: **privacy@getwellet.com**
Website: [getwellet.com](https://getwellet.com)

We aim to respond to all inquiries within 5 business days.

---

*This Privacy Policy was last updated on April 30, 2026.*
