# DataLens frontend

React + Vite frontend connected to the Node API.

## Run locally

Start the backend from the repository root first:

```bash
cp .env.example .env
docker compose up --build
```

In a second terminal:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to `http://localhost:8000/*`. Set `VITE_API_BASE_URL` to the public API base URL for deployments that do not use this local proxy.

## Connected screens

- API readiness indicator uses `GET /health/ready`.
- Upload sends CSV files to `POST /uploads/validate`.
- Project metadata uses `GET /projects/:projectId`.
- Dataset catalog uses `GET /projects/:projectId/versions/:versionId/tables`.
- Quality issues use `GET /projects/:projectId/versions/:versionId/issues`.
- Relationship view uses `GET /projects/:projectId/versions/:versionId/relationships`.
- Quality overview uses `GET /projects/:projectId/versions/:versionId/quality-score`.

The upload response's `projectId` and `versionId` are stored in local storage and used for subsequent requests. The backend runs the profiling pipeline and persists the profile, issues, inferred relationships and quality score.

## Important limitations

The login screen is preview-only; the backend has no authentication endpoints. The project is currently auto-created on first upload; no project creation endpoint exists. RAG and agentic AI are future roadmap features.
