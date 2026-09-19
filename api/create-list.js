// Crée un segment statique (MANUAL) de contacts dans HubSpot.
//
// POST /api/create-list
// Body : { "list_name": "Prospection Q4 - Optique" }
//
// Aucune vérification préalable : la création est tentée directement et
// l'erreur HubSpot est remontée telle quelle. Les noms de segments publics
// devant être uniques, un nom déjà pris renvoie l'erreur 400 de HubSpot.

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

const OBJECT_TYPE_ID = "0-1"; // contacts

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

  const listName = String(body?.list_name ?? "").trim();

  if (!listName) {
    return res.status(400).json({
      error: "Champ manquant",
      required: ["list_name"],
      received: { list_name: body?.list_name ?? null }
    });
  }

  try {
    const createRes = await fetch("https://api.hubapi.com/crm/v3/lists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: listName,
        objectTypeId: OBJECT_TYPE_ID,
        processingType: "MANUAL"
      })
    });

    const raw = await createRes.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = raw; }
    }

    // ── Erreur HubSpot : remontée telle quelle ──────────────────────────────
    if (!createRes.ok) {
      console.error("Création KO:", createRes.status, raw.slice(0, 500));

      const hints = {
        400: "Nom déjà utilisé par un autre segment, ou nom invalide — les noms de segments publics doivent être uniques.",
        401: "Token HubSpot invalide ou expiré.",
        403: "Scope manquant sur le token : il faut crm.lists.write."
      };

      return res.status(createRes.status).json({
        success: false,
        error: "HubSpot a refusé la création",
        hubspot_status: createRes.status,
        hubspot_response: payload,
        list_name: listName,
        ...(hints[createRes.status] ? { hint: hints[createRes.status] } : {})
      });
    }

    // ── Succès ──────────────────────────────────────────────────────────────
    // La réponse v3 imbrique l'ID dans "list". On lit les deux formes plutôt
    // que de supposer, et on échoue franchement si l'ID est introuvable :
    // renvoyer un succès sans list_id ne servirait à rien à l'appelant.
    const listId = payload?.list?.listId ?? payload?.listId ?? null;

    if (!listId) {
      console.error("listId introuvable dans la réponse:", raw.slice(0, 500));
      return res.status(502).json({
        success: false,
        error: "Segment créé mais listId introuvable dans la réponse HubSpot",
        hubspot_response: payload,
        list_name: listName
      });
    }

    const result = {
      success: true,
      list_id: String(listId),
      list_name: listName
    };

    if (HUBSPOT_ACCOUNT_ID) {
      result.list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;
    }

    console.log("Segment créé:", listId, listName);
    return res.status(200).json(result);

  } catch (err) {
    console.error("Erreur:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
