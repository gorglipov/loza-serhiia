
export async function onRequestGet({ env }) {
  try {
    const result = await env.DB
      .prepare("SELECT 1 AS ok")
      .first();

    return Response.json({
      success: true,
      message: "D1 connected successfully",
      database: "grape-orders",
      result: result.ok
    });
  } catch (error) {
    return Response.json({
      success: false,
      message: "Database connection failed"
    }, { status: 500 });
  }
}
