require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ALLOWED_EXTENSION_ID = process.env.ALLOWED_EXTENSION_ID || "";
const NODE_ENV = process.env.NODE_ENV || "development";

if (!SLACK_WEBHOOK_URL) {
  console.error("Missing SLACK_WEBHOOK_URL");
  process.exit(1);
}

app.use(express.json({ limit: "1mb" }));

function buildAllowedOrigins() {
  const origins = [];

  if (ALLOWED_EXTENSION_ID) {
    origins.push(`chrome-extension://${ALLOWED_EXTENSION_ID}`);
  }

  return origins;
}

const allowedOrigins = buildAllowedOrigins();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (NODE_ENV === "development") {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

function escapeSlackText(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text = "", max = 1500) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildSlackPayload({ role, company, link, location, salary, notes }) {
  const safeRole = escapeSlackText(role);
  const safeCompany = escapeSlackText(company);
  const safeLocation = escapeSlackText(location || "");
  const safeSalary = escapeSlackText(salary || "");
  const safeNotes = escapeSlackText(truncate(notes || "", 1200));
  const safeLink = link;

  const fields = [
    {
      type: "mrkdwn",
      text: `*Role:*
${safeRole}`
    },
    {
      type: "mrkdwn",
      text: `*Company:*
${safeCompany}`
    }
  ];

  if (safeLocation) {
    fields.push({
      type: "mrkdwn",
      text: `*Location:*
${safeLocation}`
    });
  }

  if (safeSalary) {
    fields.push({
      type: "mrkdwn",
      text: `*Salary:*
${safeSalary}`
    });
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "New Job Captured"
      }
    },
    {
      type: "section",
      fields
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Job Link:*
<${safeLink}|Open Posting>`
      }
    }
  ];

  if (safeNotes) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Notes:*
${safeNotes}`
      }
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Captured at ${new Date().toISOString()}`
      }
    ]
  });

  return {
    text: `New job captured: ${safeRole} at ${safeCompany}`,
    blocks
  };
}

async function postToSlack(payload) {
  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(`Slack rate limited the request. Retry after ${retryAfter || "unknown"} seconds.`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook failed: ${text}`);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    allowedExtensionConfigured: Boolean(ALLOWED_EXTENSION_ID)
  });
});

app.post("/api/jobs/send-to-slack", async (req, res) => {
  try {
    const {
      role = "",
      company = "",
      link = "",
      location = "",
      salary = "",
      notes = ""
    } = req.body || {};

    if (!role.trim() || !company.trim() || !link.trim()) {
      return res.status(400).json({
        error: "role, company, and link are required"
      });
    }

    try {
      new URL(link.trim());
    } catch {
      return res.status(400).json({
        error: "link must be a valid URL"
      });
    }

    const payload = buildSlackPayload({
      role: role.trim(),
      company: company.trim(),
      link: link.trim(),
      location: location.trim(),
      salary: salary.trim(),
      notes: notes.trim()
    });

    await postToSlack(payload);

    return res.json({
      success: true,
      message: "Sent to Slack successfully"
    });
  } catch (error) {
    console.error("send-to-slack error:", error);
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
