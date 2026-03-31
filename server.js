require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const ALLOWED_EXTENSION_ID = process.env.ALLOWED_EXTENSION_ID || "";
const NODE_ENV = process.env.NODE_ENV || "development";

if (!SLACK_WEBHOOK_URL && !DISCORD_WEBHOOK_URL) {
  console.error("Missing webhook configuration. Set SLACK_WEBHOOK_URL and/or DISCORD_WEBHOOK_URL");
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
      text: `*Role:*\n${safeRole}`
    },
    {
      type: "mrkdwn",
      text: `*Company:*\n${safeCompany}`
    }
  ];

  if (safeLocation) {
    fields.push({
      type: "mrkdwn",
      text: `*Location:*\n${safeLocation}`
    });
  }

  if (safeSalary) {
    fields.push({
      type: "mrkdwn",
      text: `*Salary:*\n${safeSalary}`
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
        text: `*Job Link:*\n<${safeLink}|Open Posting>`
      }
    }
  ];

  if (safeNotes) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Notes:*\n${safeNotes}`
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

function buildDiscordPayload({ role, company, link, location, salary, notes }) {
  const parts = [
    `**New Job Captured**`,
    `**Role:** ${truncate(role, 300)}`,
    `**Company:** ${truncate(company, 300)}`,
    `**Job Link:** ${link}`
  ];

  if (location) {
    parts.push(`**Location:** ${truncate(location, 300)}`);
  }

  if (salary) {
    parts.push(`**Salary:** ${truncate(salary, 300)}`);
  }

  if (notes) {
    parts.push(`**Notes:** ${truncate(notes, 1000)}`);
  }

  parts.push(`**Captured At:** ${new Date().toISOString()}`);

  return {
    content: parts.join("\n")
  };
}

async function postToSlack(payload) {
  if (!SLACK_WEBHOOK_URL) return;

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

async function postToDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) return;

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(`Discord rate limited the request. Retry after ${retryAfter || "unknown"} seconds.`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed: ${text}`);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    allowedExtensionConfigured: Boolean(ALLOWED_EXTENSION_ID),
    slackConfigured: Boolean(SLACK_WEBHOOK_URL),
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL)
  });
});

app.post("/api/jobs/send", async (req, res) => {
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

    const cleanData = {
      role: role.trim(),
      company: company.trim(),
      link: link.trim(),
      location: location.trim(),
      salary: salary.trim(),
      notes: notes.trim()
    };

    const slackPayload = buildSlackPayload(cleanData);
    const discordPayload = buildDiscordPayload(cleanData);

    const results = {
      slack: null,
      discord: null
    };

    if (SLACK_WEBHOOK_URL) {
      try {
        await postToSlack(slackPayload);
        results.slack = "sent";
      } catch (error) {
        results.slack = `failed: ${error.message}`;
      }
    }

    if (DISCORD_WEBHOOK_URL) {
      try {
        await postToDiscord(discordPayload);
        results.discord = "sent";
      } catch (error) {
        results.discord = `failed: ${error.message}`;
      }
    }

    const allFailed =
      (!SLACK_WEBHOOK_URL || String(results.slack).startsWith("failed")) &&
      (!DISCORD_WEBHOOK_URL || String(results.discord).startsWith("failed"));

    if (allFailed) {
      return res.status(500).json({
        error: "Failed to send to all configured destinations",
        results
      });
    }

    return res.json({
      success: true,
      message: "Job sent to configured destinations",
      results
    });
  } catch (error) {
    console.error("send error:", error);
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
