// Implement the API contract in specs/issue-tracker.md (TEST-API).
export async function handleApi(_req, res) {
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_IMPLEMENTED', message: 'Issue API is pending TEST-API.' } }));
}
