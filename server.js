require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const XLSX = require("xlsx");
const rateLimit = require("express-rate-limit");
const { listResumesInFolder, searchFolders, getFolderInfo, processDriveFolder } = require("./googleDrive");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy for Vercel/Railway/Render
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait 15 minutes." },
});
app.use("/api/", limiter);

// Multer setup - store in memory
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".pdf", ".docx", ".doc"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// AI Client (Gemini or OpenAI fallback)
let genAI = null;
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Use gemini-1.5-flash-latest or gemini-pro for best results
  const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  geminiModel = genAI.getGenerativeModel({ model: modelName });
  console.log(`Using Google Gemini (FREE) - Model: ${modelName}`);
} else if (process.env.OPENAI_API_KEY) {
  console.log("Using OpenAI");
}

// AI generation function with retry on rate limit
async function generateAIResponse(prompt, retries = 2) {
  if (geminiModel) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        return response.text();
      } catch (err) {
        const status = err.status || (err.message && err.message.includes('429') ? 429 : 0);
        if ((status === 429 || status === 503) && attempt < retries) {
          const delay = 5000;
          console.log(`Rate limited, retrying in ${delay/1000}s (attempt ${attempt + 1}/${retries})...`);
          await sleep(delay);
          continue;
        }
        console.error("Gemini API error:", err.status, err.message);
        throw err;
      }
    }
  } else if (process.env.OPENAI_API_KEY) {
    const openai = new (require("openai"))({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 800,
    });
    return response.choices[0].message.content.trim();
  } else {
    throw new Error("No AI provider configured. Set GEMINI_API_KEY or OPENAI_API_KEY");
  }
}

// ─── Resume Text Extraction ───────────────────────────────────────────────────
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === ".pdf") {
      const data = await pdfParse(buffer);
      return data.text;
    } else if (ext === ".docx" || ext === ".doc") {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
  } catch (err) {
    console.error(`Failed to extract text from ${filename}:`, err.message);
    return "";
  }
  return "";
}

// ─── AI: Extract info AND score in one call per resume ──────────────────────
async function extractAndScore(resumeText, filename, jd) {
  const preferredLocation = jd.location || jd.other || "";
  const prompt = `You are a strict HR analyst and technical recruiter. Evaluate the resume RIGOROUSLY.

JOB DESCRIPTION:
Role: ${jd.role}
Required Skills (ALL must match for high score): ${jd.skills}
Experience Required: ${jd.experience} years
Notice Period Acceptable: ${jd.notice}
Preferred Location: ${preferredLocation}

STRICT SCORING RULES:
1. skill_match: Count ONLY skills explicitly mentioned in the resume that match required skills. 
   Formula: (matched skills / total required skills) * 100. 
   If candidate has 2 out of 4 required skills = 50%. Do NOT give credit for partial or unrelated skills.
2. match_score: Weighted average — skill_match(50%) + experience_match(30%) + notice_match(20%).
   PENALIZE heavily if fewer than half the required skills are present.
3. experience_match: If required is ${jd.experience} years and candidate has less = proportional score. Over-experienced is 100%.
4. notice_match: 100 if within acceptable notice, 50 if slightly over, 0 if way over or unknown.
5. Location: If preferred location is specified and candidate is in a DIFFERENT city, deduct 15 points from match_score. Same city = no deduction.
6. recommendation: 
   - "Strong Match" ONLY if match_score >= 80
   - "Good Match" if 65-79
   - "Moderate Match" if 45-64
   - "Weak Match" if < 45

RESUME (${filename}):
${resumeText.substring(0, 3500)}

Return ONLY this exact JSON, no markdown, no extra text:
{
  "name": "Full name or 'Unknown'",
  "email": "email or ''",
  "phone": "phone or ''",
  "total_experience_years": 0,
  "current_company": "company or ''",
  "current_role": "role or ''",
  "skills": ["skill1", "skill2"],
  "education": "qualification or ''",
  "notice_period": "notice or 'Not mentioned'",
  "current_location": "city or ''",
  "summary": "2-3 sentence summary",
  "match_score": 0,
  "skill_match": 0,
  "experience_match": 0,
  "notice_match": 0,
  "strengths": ["point1"],
  "gaps": ["gap1"],
  "recommendation": "Strong Match",
  "reasoning": "2-3 sentence explanation mentioning skill match count and location"
}`;

  try {
    const content = await generateAIResponse(prompt);
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1].trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error(`AI processing failed for ${filename}:`, err.message);
    return {
      name: filename.replace(/\.[^.]+$/, ""),
      email: "", phone: "",
      total_experience_years: 0,
      current_company: "", current_role: "",
      skills: [], education: "",
      notice_period: "Not mentioned", current_location: "",
      summary: "Could not extract details.",
      match_score: 0, skill_match: 0, experience_match: 0, notice_match: 0,
      strengths: [], gaps: ["Could not process"],
      recommendation: "Unknown", reasoning: "Processing failed.",
    };
  }
}

// ─── Process resumes in parallel batches ─────────────────────────────────────
async function processResumesBatch(files, jd) {
  const batchSize = 5;
  const results = [];
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async ({ text, filename }) => {
        const result = await extractAndScore(text, filename, jd);
        return result;
      })
    );
    results.push(...batchResults);
    if (i + batchSize < files.length) await sleep(1000);
  }
  return results;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  const aiProvider = process.env.GEMINI_API_KEY ? "gemini" : 
                     process.env.OPENAI_API_KEY ? "openai" : "none";
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    aiProvider,
    googleDrive: !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
  });
});

// ─── Google Drive Routes ─────────────────────────────────────────────────────

// Search for folders by name
app.get("/api/drive/search-folders", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Query parameter 'q' required" });
    }
    
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return res.status(500).json({ error: "Google Drive not configured" });
    }
    
    const folders = await searchFolders(q);
    res.json({ success: true, folders });
  } catch (err) {
    console.error("Search folders error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get folder info
app.get("/api/drive/folder/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return res.status(500).json({ error: "Google Drive not configured" });
    }
    
    const [folderInfo, files] = await Promise.all([
      getFolderInfo(id),
      listResumesInFolder(id)
    ]);
    
    res.json({ 
      success: true, 
      folder: folderInfo,
      fileCount: files.length,
      files: files.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
    });
  } catch (err) {
    console.error("Get folder error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Rank resumes from Google Drive folder
app.post("/api/rank-drive", express.json(), async (req, res) => {
  try {
    const { folderId, jd, maxResumes } = req.body;
    const limit = Math.min(parseInt(maxResumes) || 20, 50);
    
    if (!folderId) {
      return res.status(400).json({ error: "folderId is required" });
    }
    
    if (!jd?.role || !jd?.skills) {
      return res.status(400).json({ error: "Job description is incomplete" });
    }
    
    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "AI API key not configured. Set GEMINI_API_KEY or OPENAI_API_KEY" });
    }
    
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return res.status(500).json({ error: "Google Drive not configured" });
    }
    
    console.log(`Fetching resumes from Drive folder: ${folderId}`);
    
    // Fetch all resumes from Drive
    const driveFiles = await processDriveFolder(folderId, (current, total, name) => {
      console.log(`Downloading ${current}/${total}: ${name}`);
    });
    
    const validFiles = driveFiles.filter(f => !f.error).slice(0, limit);
    
    if (validFiles.length === 0) {
      return res.status(400).json({ error: "No valid resume files found in folder" });
    }
    
    console.log(`Processing ${validFiles.length} resumes...`);
    
    // Extract text then process all resumes (extract+score in 1 AI call each)
    const extracted = await Promise.all(validFiles.map(async (file) => {
      const text = await extractText(file.buffer, file.name);
      return { filename: file.name, text };
    }));

    const scored = await processResumesBatch(extracted, jd);

    // Sort and rank
    scored.sort((a, b) => b.match_score - a.match_score);
    const ranked = scored.map((c, i) => ({ rank: i + 1, ...c }));
    
    res.json({
      success: true,
      source: "google-drive",
      folderId,
      total: ranked.length,
      candidates: ranked,
    });
  } catch (err) {
    console.error("Error in /api/rank-drive:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Main ranking endpoint
app.post("/api/rank", upload.array("resumes", 50), async (req, res) => {
  try {
    const files = req.files;
    const jdData = JSON.parse(req.body.jd || "{}");

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No resume files uploaded." });
    }

    if (!jdData.role || !jdData.skills) {
      return res.status(400).json({ error: "Job description is incomplete." });
    }

    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "AI API key not configured. Set GEMINI_API_KEY or OPENAI_API_KEY" });
    }

    // Extract text then process all resumes (extract+score in 1 AI call each)
    console.log(`Processing ${files.length} resumes...`);
    const extracted = await Promise.all(files.map(async (file) => {
      const text = await extractText(file.buffer, file.originalname);
      return { filename: file.originalname, text };
    }));

    const scored = await processResumesBatch(extracted, jdData);
    scored.sort((a, b) => b.match_score - a.match_score);
    const ranked = scored.map((c, i) => ({ rank: i + 1, ...c }));

    return res.json({
      success: true,
      total: ranked.length,
      candidates: ranked,
    });
  } catch (err) {
    console.error("Error in /api/rank:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// Excel export endpoint
app.post("/api/export", express.json({ limit: "5mb" }), (req, res) => {
  try {
    const { candidates, jd } = req.body;

    if (!candidates || candidates.length === 0) {
      return res.status(400).json({ error: "No candidates to export." });
    }

    const rows = candidates.map((c) => ({
      Rank: c.rank,
      "Candidate Name": c.name,
      Email: c.email,
      Phone: c.phone,
      "Match Score (%)": c.match_score,
      "Skill Match (%)": c.skill_match,
      "Experience Match (%)": c.experience_match,
      "Notice Match (%)": c.notice_match,
      Recommendation: c.recommendation,
      "Current Role": c.current_role,
      "Current Company": c.current_company,
      "Total Experience (Yrs)": c.total_experience_years,
      "Notice Period": c.notice_period,
      Location: c.current_location,
      Education: c.education,
      Skills: (c.skills || []).join(", "),
      Strengths: (c.strengths || []).join("; "),
      Gaps: (c.gaps || []).join("; "),
      Reasoning: c.reasoning,
      "Resume File": c.filename || "",
    }));

    const wb = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ["AI Resume Ranking Report"],
      ["Generated:", new Date().toLocaleString()],
      ["Job Role:", jd?.role || ""],
      ["Required Skills:", jd?.skills || ""],
      ["Experience Required:", `${jd?.experience || ""} years`],
      ["Package:", jd?.package || ""],
      ["Notice Period:", jd?.notice || ""],
      [],
      ["Total Resumes Processed:", candidates.length],
      ["Top Match:", candidates[0]?.name || ""],
      ["Top Score:", candidates[0]?.match_score || ""],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary["!cols"] = [{ wch: 30 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

    // Candidates sheet
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [
      { wch: 6 }, { wch: 25 }, { wch: 30 }, { wch: 15 },
      { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 },
      { wch: 16 }, { wch: 25 }, { wch: 25 }, { wch: 16 },
      { wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 40 },
      { wch: 40 }, { wch: 40 }, { wch: 50 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Ranked Candidates");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="resume_ranking_${Date.now()}.xlsx"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Failed to generate Excel report." });
  }
});

app.listen(PORT, () => {
  const aiProvider = process.env.GEMINI_API_KEY ? "Google Gemini (FREE)" : 
                     process.env.OPENAI_API_KEY ? "OpenAI" : "NOT CONFIGURED";
  console.log(`Resume Ranker API running on http://localhost:${PORT}`);
  console.log(`AI Provider: ${aiProvider}`);
  console.log(`Google Drive integration: ${process.env.GOOGLE_CLIENT_EMAIL ? 'ENABLED' : 'DISABLED'}`);
});
