# DataLens frontend

React + Vite frontend for the DataLens data-quality workspace.

## Run locally
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```
Open http://localhost:5173. Configure `VITE_API_BASE_URL=http://localhost:8000` in `.env` to connect to the Node API. Run the backend separately using the repository Docker Compose setup.

## Screens
- Preview sign-in (UI only; not production authentication)
- Data quality overview
- CSV upload and profiling request
- Dataset and schema browser
- Quality issue register with severity filters
- Cross-table relationship review

When no project/version is loaded, the overview uses illustrative preview metrics. Uploading CSVs calls `POST /uploads/validate` and stores the returned project/version identifiers in browser local storage.

## Security and roadmap
The sign-in screen is a preview gate only. No password is collected or stored, and the backend currently has no authentication endpoints. Before production use, implement server-side authentication, session management, authorization, secure cookie handling, CSRF protection where applicable, and tenant isolation.

Future AI capabilities should be introduced behind separate API modules: a retrieval service for RAG over approved metadata/documentation, and an agent orchestration layer with explicit tools, permissions, audit logs, and human approval for consequential actions. These are roadmap items, not active frontend features yet.