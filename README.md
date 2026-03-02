# TwiLight Smart Home

A modern, secure smart home dashboard for controlling and monitoring smart devices.

## Features

- **Dashboard** — Real-time overview with favorite devices, rooms, scenes, and KPIs
- **Device Control** — Toggle, dim, and adjust 20+ device types (lights, fans, thermostats, plugs, locks)
- **Smart Integrations** — Connect Govee and LIFX devices via free APIs
- **Scenes & Automations** — Pre-built routines like Movie Night, Good Morning, Away Mode
- **Energy Monitoring** — Track usage with interactive charts and cost breakdowns
- **Secure Auth** — Sign in/sign up with password strength validation and session management
- **Dark/Light Mode** — Full theme support with twilight-inspired design tokens
- **Responsive** — Works on desktop, tablet, and mobile

## Architecture

This is the **frontend** (public) repository containing the UI:

- `index.html` — Dashboard layout with auth screen, sidebar nav, and 7 views
- `app.js` — Client-side logic, auth flow, device management, smart device controls
- `style.css` — Design system with twilight color tokens and dark/light mode
- `auth.css` — Split-layout authentication page styles
- `base.css` — CSS resets and accessibility foundations

The **backend API** lives in a separate private repository: [`twilight-api`](https://github.com/jonahlage/twilight-api)

## Smart Device Providers

| Provider | Features | API |
|----------|----------|-----|
| **Govee** | LED lights, strips, home devices | Free tier |
| **LIFX** | WiFi light bulbs and strips | Free tier |

## Security

- No sensitive data in this public repo
- API keys are encrypted at rest on the backend
- Session-based auth with PBKDF2-SHA256
- Rate limiting and account lockout protection
- No localStorage (sandboxed environment)
