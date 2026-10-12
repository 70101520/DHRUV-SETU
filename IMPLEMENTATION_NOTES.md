# Dhruv-Setu CRM — Implementation Notes

## Product language

All CRM screens, field labels, validation messages, reports, and customer emails use English. Project discussions may be held in Hinglish.

## Implemented

- Email/User ID and password login experience
- User, Support, and Admin role-based navigation
- Dashboard totals and docket activity overview
- Unique docket reference generation
- Customer mobile, name, email, address, destination, query, and remarks
- Admin-managed dropdown and checkbox fields shown on docket forms
- Docket search plus status and date filters
- Support report access controlled by Admin
- CSV report download
- SMTP settings and editable customer email template
- Template variables for customer name, docket number, destination, and mobile number
- Profile and logout actions
- Responsive desktop and mobile layouts
- Browser persistence for the interactive prototype

## Production integrations

The following items require deployment credentials or provider details and must be connected through a secure server-side API:

- Production user database and password authentication
- Real SMTP email delivery
- Dialer provider API and call-event webhooks
- Server-side report authorization and audit logs
- Database backups and operational monitoring

Never store SMTP passwords, dialer keys, or production user passwords in browser storage or committed source files.
