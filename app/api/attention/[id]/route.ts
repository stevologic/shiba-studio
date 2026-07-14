export async function PATCH() {
  return Response.json({
    ok: false,
    error: 'Attention items are exact approvals. Approve or deny them through the bound task command.',
  }, { status: 409 });
}
