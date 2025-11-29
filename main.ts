// main.ts
// Deno REST API for your Neo4j manufacturing PoC

import neo4j from "https://deno.land/x/neo4j_driver_lite@5.14.0/mod.ts";

// --- Config: environment variables (set locally via .env and in Deno Deploy) ---
const NEO4J_URI = Deno.env.get("NEO4J_URI") ?? "";
const NEO4J_USERNAME = Deno.env.get("NEO4J_USERNAME") ?? "neo4j";
const NEO4J_PASSWORD = Deno.env.get("NEO4J_PASSWORD") ?? "";
const NEO4J_DATABASE = Deno.env.get("NEO4J_DATABASE") ?? "neo4j";

if (!NEO4J_URI || !NEO4J_PASSWORD) {
    console.warn("NEO4J_URI or NEO4J_PASSWORD not set. Check your env vars.");
}

// --- Neo4j driver ---
const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD)
);

// small helper: convert Neo4j int to JS number
function asNumber(value: unknown): number {
    // @ts-ignore: driver-lite exposes isInt
    if (neo4j.isInt?.(value)) {
        // deno-lint-ignore no-explicit-any
        return (value as any).toNumber();
    }
    return typeof value === "number" ? value : Number(value);
}

// --- HTTP helpers ---
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function handleRandomSerials(): Promise<Response> {
    const query = `
    MATCH (p:Serial)
    WITH p, rand() AS r
    ORDER BY r
    LIMIT 10
    RETURN p.serialNumber AS serial
  `;

    const result = await driver.executeQuery(
        query,
        {},
        { database: NEO4J_DATABASE }
    );

    const serials = result.records.map((r) => r.get("serial") as string);
    return jsonResponse({ serials });
}

async function handleClear(): Promise<Response> {
    await driver.executeQuery(
        "MATCH (n) DETACH DELETE n",
        {},
        { database: NEO4J_DATABASE }
    );

    return jsonResponse({ ok: true, message: "Database cleared" });
}

async function handleSeed(): Promise<Response> {
    // 1) Suppliers, materials, models, SUPPLIES
    const q1 = `
    // suppliers
    UNWIND [
      {supplierId:'S1', name:'Alpha Components', qualityGroup:'GOOD'},
      {supplierId:'S2', name:'Bravo Metals',     qualityGroup:'GOOD'},
      {supplierId:'S3', name:'Charlie Plastics', qualityGroup:'GOOD'},
      {supplierId:'S4', name:'Echo Electronics', qualityGroup:'GOOD'},
      {supplierId:'S5', name:'Delta Supplies',   qualityGroup:'BAD'}
    ] AS sData
    MERGE (s:Supplier {supplierId: sData.supplierId})
      ON CREATE SET s.name = sData.name, s.qualityGroup = sData.qualityGroup
      ON MATCH  SET s.name = sData.name, s.qualityGroup = sData.qualityGroup;

    // materials
    UNWIND [
      {materialId:'M1', name:'Plastic Housing'},
      {materialId:'M2', name:'Metal Bracket'},
      {materialId:'M3', name:'PCB Board'},
      {materialId:'M4', name:'Cable Harness'}
    ] AS mData
    MERGE (m:Material {materialId: mData.materialId})
      ON CREATE SET m.name = mData.name
      ON MATCH  SET m.name = mData.name;

    // product models
    UNWIND [
      {modelId:'P1', name:'Widget A'},
      {modelId:'P2', name:'Widget B'},
      {modelId:'P3', name:'Widget C'}
    ] AS pData
    MERGE (pm:ProductModel {modelId: pData.modelId})
      ON CREATE SET pm.name = pData.name
      ON MATCH  SET pm.name = pData.name;

    // supplies relationships
    UNWIND [
      {supplierId:'S1', materials:['M1','M2']},
      {supplierId:'S2', materials:['M1','M3']},
      {supplierId:'S3', materials:['M2','M4']},
      {supplierId:'S4', materials:['M3','M4']},
      {supplierId:'S5', materials:['M1','M2','M3']}
    ] AS row
    MATCH (s:Supplier {supplierId: row.supplierId})
    UNWIND row.materials AS matId
    MATCH (m:Material {materialId: matId})
    MERGE (s)-[:SUPPLIES]->(m);
  `;

    // 2) Batches
    const q2 = `
    MATCH (s:Supplier)-[:SUPPLIES]->(m:Material)
    WITH s, m
    UNWIND range(1,5) AS batchNum
    MERGE (b:Batch {
      batchId: s.supplierId + '_' + m.materialId + '_B' + toString(batchNum)
    })
      ON CREATE SET
        b.receivedDate = date('2025-01-01') + duration({days: toInteger(rand() * 60)}),
        b.lotNumber    = 'LOT-' + s.supplierId + '-' + m.materialId + '-' + toString(batchNum)
    MERGE (s)-[:DELIVERED]->(b)
    MERGE (b)-[:OF_MATERIAL]->(m);
  `;

    // 3) Serials & inspections
    const q3 = `
    MATCH (b:Batch)<-[:DELIVERED]-(s:Supplier)
    WITH b, s, toInteger(5 + rand() * 10) AS serialCount
    UNWIND range(1, serialCount) AS n
    MATCH (pm:ProductModel)
    WITH b, s, n, collect(pm) AS models
    WITH b, s, n, models[toInteger(rand() * size(models))] AS pm
    CREATE (p:Serial {
      serialNumber: 'SN_' + b.batchId + '_' + toString(n),
      productionDate: b.receivedDate + duration({days: toInteger(rand() * 30)})
    })
    MERGE (b)-[:USED_IN]->(p)
    MERGE (p)-[:INSTANCE_OF]->(pm)
    WITH b, s, p,
         CASE
           WHEN s.qualityGroup = 'BAD'
             THEN CASE WHEN rand() < 0.20 THEN 'REJECT' ELSE 'OK' END
           ELSE
             CASE WHEN rand() < 0.03 THEN 'REJECT' ELSE 'OK' END
         END AS status
    CREATE (i:Inspection {
      inspectionId: 'INSP_' + p.serialNumber,
      date: p.productionDate + duration({days:1}),
      status: status,
      defectCode:
        CASE
          WHEN status = 'REJECT' THEN
            ['CRACK','DISCOLOR','DIMENSION','SCRATCH'][toInteger(rand() * 4)]
          ELSE null
        END
    })
    MERGE (p)-[:HAS_INSPECTION]->(i);
  `;

    await driver.executeQuery(q1, {}, { database: NEO4J_DATABASE });
    await driver.executeQuery(q2, {}, { database: NEO4J_DATABASE });
    await driver.executeQuery(q3, {}, { database: NEO4J_DATABASE });

    return jsonResponse({
        ok: true,
        message:
            "Sample data created. Use /api/suppliers/quality or /api/serial/random to explore it.",
    });
}

// --- Router ---

Deno.serve(async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const { pathname } = url;

    try {
        // health
        if (pathname === "/api/health" && req.method === "GET") {
            return jsonResponse({ ok: true });
        }

        // analytics
        if (pathname === "/api/suppliers/quality" && req.method === "GET") {
            return await handleSuppliersQuality();
        }

        // trace one serial
        const traceMatch = pathname.match(/^\/api\/serial\/(.+)\/trace$/);
        if (traceMatch && req.method === "GET") {
            const serial = decodeURIComponent(traceMatch[1]);
            return await handleSerialTrace(serial);
        }

        // 10 random serials
        if (pathname === "/api/serial/random" && req.method === "GET") {
            return await handleRandomSerials();
        }

        // admin: clear DB
        if (pathname === "/api/admin/clear" && req.method === "POST") {
            return await handleClear();
        }

        // admin: seed demo data
        if (pathname === "/api/admin/seed" && req.method === "POST") {
            return await handleSeed();
        }

        return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
        console.error("Error handling request:", err);
        return jsonResponse({ error: "Internal server error" }, 500);
    }
});
