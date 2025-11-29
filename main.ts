// main.ts
// Deno REST API for your Neo4j manufacturing PoC

import neo4j from "https://deno.land/x/neo4j_driver_lite@5.14.0/mod.ts";

// --- Config: taken from environment variables (set these in Deno Deploy) ---
const NEO4J_URI = Deno.env.get("NEO4J_URI") ?? "";
const NEO4J_USERNAME = Deno.env.get("NEO4J_USERNAME") ?? "neo4j";
const NEO4J_PASSWORD = Deno.env.get("NEO4J_PASSWORD") ?? "";
const NEO4J_DATABASE = Deno.env.get("NEO4J_DATABASE") ?? "neo4j";

if (!NEO4J_URI || !NEO4J_PASSWORD) {
    console.warn(
        "WARNING: NEO4J_URI or NEO4J_PASSWORD not set. Set them in Deno Deploy env."
    );
}

// --- Neo4j driver (single instance, reused for all requests) ---
const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD)
);

// Utility: convert Neo4j integers to JS numbers
function asNumber(value: unknown): number {
    // For small datasets this is perfectly fine
    if (typeof value === "number") return value;
    // neo4j_driver_lite exposes the same helpers as the JS driver
    // @ts-ignore
    if (neo4j.isInt?.(value)) return (value as any).toNumber();
    return Number(value);
}

// --- Common HTTP helpers ---
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
        },
    });
}

// --- Handlers ---

async function handleSuppliersQuality(): Promise<Response> {
    const query = `
    MATCH (s:Supplier)-[:DELIVERED]->(b:Batch)-[:USED_IN]->(p:Serial)-[:HAS_INSPECTION]->(i:Inspection)
    WITH s, count(DISTINCT p) AS total,
         count(DISTINCT CASE WHEN i.status = 'REJECT' THEN p END) AS rejected
    RETURN s.supplierId AS supplierId,
           s.name       AS supplier,
           total,
           rejected,
           100.0 * rejected / total AS rejectRatePercent
    ORDER BY rejectRatePercent DESC
  `;

    const result = await driver.executeQuery(
        query,
        {},
        { database: NEO4J_DATABASE }
    );

    const rows = result.records.map((record) => ({
        supplierId: record.get("supplierId"),
        supplier: record.get("supplier"),
        total: asNumber(record.get("total")),
        rejected: asNumber(record.get("rejected")),
        rejectRatePercent: Number(record.get("rejectRatePercent")),
    }));

    return jsonResponse(rows);
}

async function handleSerialTrace(serial: string): Promise<Response> {
    const query = `
    MATCH (p:Serial {serialNumber: $serial})
    OPTIONAL MATCH (p)-[:HAS_INSPECTION]->(i:Inspection)
    OPTIONAL MATCH (b:Batch)-[:USED_IN]->(p)
    OPTIONAL MATCH (s:Supplier)-[:DELIVERED]->(b)
    OPTIONAL MATCH (b)-[:USED_IN]->(other:Serial)
    WITH p, i, b, s, collect(DISTINCT other.serialNumber) AS affectedSerials
    RETURN p.serialNumber AS serial,
           coalesce(i.status, 'UNKNOWN') AS status,
           b.batchId AS batchId,
           s.supplierId AS supplierId,
           s.name AS supplierName,
           affectedSerials
  `;

    const result = await driver.executeQuery(
        query,
        { serial },
        { database: NEO4J_DATABASE }
    );

    if (result.records.length === 0) {
        return jsonResponse({ error: "Serial not found" }, 404);
    }

    const record = result.records[0];
    const body = {
        serial: record.get("serial"),
        status: record.get("status"),
        batchId: record.get("batchId"),
        supplierId: record.get("supplierId"),
        supplierName: record.get("supplierName"),
        affectedSerials: record.get("affectedSerials") ?? [],
    };

    return jsonResponse(body);
}

// --- Main request router ---

Deno.serve(async (req: Request): Promise<Response> => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const { pathname } = url;

    try {
        if (pathname === "/api/health") {
            return jsonResponse({ ok: true, uptime: "👍" });
        }

        if (pathname === "/api/suppliers/quality" && req.method === "GET") {
            return await handleSuppliersQuality();
        }

        // /api/serial/:serial/trace
        const serialMatch = pathname.match(/^\/api\/serial\/(.+)\/trace$/);
        if (serialMatch && req.method === "GET") {
            const serial = decodeURIComponent(serialMatch[1]);
            return await handleSerialTrace(serial);
        }

        return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
        console.error("Error handling request:", err);
        return jsonResponse({ error: "Internal server error" }, 500);
    }
});
