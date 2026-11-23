# DataSage Frontend

React + TypeScript + Vite dashboard for DataSage.

## Run locally

```bash
cd DataSage/frontend
npm install
cp .env.example .env
npm run dev
```

Set `VITE_API_BASE_URL` to the base URL of the existing Node.js API. The frontend uses `POST /uploads/validate` and the version-scoped project endpoints for tables, issues, quality score, and relationships.

The dashboard intentionally displays empty states when the API returns no data. It does not invent quality scores or relationship results.

## Build

```bash
npm run build
```
