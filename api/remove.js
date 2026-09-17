// Retire un contact d'un segment statique HubSpot.
// /!\ Ne supprime PAS le contact du CRM : il est uniquement exclu du segment.
//
// POST /api/remove
// Body : { "contact_id": "12345", "list_id": "611" }
//
// Le retrait manuel n'est possible que sur les segments MANUAL (statique) ou
// SNAPSHOT. Un segment DYNAMIC (actif) recalcule ses membres via ses filtres :
// HubSpot refusera l'appel.

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed — utiliser POST" });
  }

  if (!HUBSPOT_TOKEN) {
    return res.status(500).json({ error: "HUBSPOT_TOKEN absent des variables d'environnement" });
  }

  // Clay envoie parfois le body en string selon la config du HTTP API call
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { contact_id, list_id } = body || {};

  if (!contact_id || !list_id) {
    return res.status(400).json({
      error: "Champs manquants",
      required: ["contact_id", "list_id"],
      received: { contact_id: contact_id ?? null, list_id: list_id ?? null }
    });
  }

  // HubSpot attend des chaînes dans le tableau d'IDs
  const recordId = String(contact_id).trim();
  const listId = String(list_id).trim();

  try {
    const hsRes = await fetch(
      `https://api.hubapi.com/crm/v3/lists/${encodeURIComponent(listId)}/memberships/remove`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([recordId])
      }
    );

    const raw = await hsRes.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = raw; }
    }

    // ── Échec côté HubSpot : on remonte le vrai statut, pas un faux succès ──
    if (!hsRes.ok) {
      console.error("HubSpot remove KO:", hsRes.status, raw.slice(0, 500));

      const hints = {
        400: "Vérifier que le segment est bien statique (MANUAL/SNAPSHOT) — un segment actif (DYNAMIC) refuse le retrait manuel.",
        401: "Token HubSpot invalide ou expiré.",
        403: "Scope manquant sur le token : il faut crm.lists.write.",
        404: `Aucun segment avec l'ILS list ID ${listId}.`
      };

      return res.status(hsRes.status === 404 ? 404 : 502).json({
        success: false,
        error: "HubSpot a refusé le retrait",
        hubspot_status: hsRes.status,
        hubspot_response: payload,
        ...(hints[hsRes.status] ? { hint: hints[hsRes.status] } : {})
      });
    }

    // ── Succès : on distingue « retiré » de « n'était pas membre » ──────────
    // HubSpot renvoie des tableaux d'IDs ; le nom du champ a varié selon les
    // versions, d'où la double lecture. null = information indisponible.
    const removedIds = payload?.recordIdsRemoved ?? payload?.recordsIdsRemoved ?? null;
    const missingIds = payload?.recordIdsMissing ?? null;

    const inList = (arr) =>
      Array.isArray(arr) ? arr.map(String).includes(recordId) : null;

    const result = {
      success: true,
      contact_id: recordId,
      list_id: listId,
      removed: inList(removedIds),        // true = retiré du segment
      already_absent: inList(missingIds), // true = n'y était déjà plus
      hubspot_response: payload
    };

    if (HUBSPOT_ACCOUNT_ID) {
      result.list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;
    }

    console.log("Removed", recordId, "from list", listId, "->", hsRes.status);
    return res.status(200).json(result);

  } catch (err) {
    console.error("Erreur:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
