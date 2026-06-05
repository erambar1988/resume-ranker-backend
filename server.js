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

// AI generation function (supports both Gemini and OpenAI)
async function generateAIResponse(prompt) {
  if (geminiModel) {
    try {
      const result = await geminiModel.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (err) {
      console.error("Gemini API error:", err.status, err.message, JSON.stringify(err.errorDetails || {}));
      throw err;
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

// ─── AI: Extract candidate info from resume text ─────────────────────────────
async function extractCandidateInfo(resumeText, filename) {
  const prompt = `You are an expert HR analyst. Extract the following information from the resume text below.
Return ONLY valid JSON, no markdown, no extra text.

Resume filename: ${filename}
Resume text:
${resumeText.substring(0, 4000)}

Extract and return this JSON structure:
{
  "name": "Full name or 'Unknown' if not found",
  "email": "Email address or ''",
  "phone": "Phone number or ''",
  "total_experience_years": number (0 if not found),
  "current_company": "Current/last company or ''",
  "current_role": "Current/last job title or ''",
  "skills": ["skill1", "skill2", ...],
  "education": "Highest qualification or ''",
  "notice_period": "Notice period or 'Not mentioned'",
  "current_location": "City/location or ''",
  "summary": "2-3 sentence professional summary"
}`;

  try {
    const content = await generateAIResponse(prompt);
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1].trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error(`AI extraction failed for ${filename}:`, err.message);
    return {
      name: filename.replace(/\.[^.]+$/, ""),
      email: "",
      phone: "",
      total_experience_years: 0,
      current_company: "",
      current_role: "",
      skills: [],
      education: "",
      notice_period: "Not mentioned",
      current_location: "",
      summary: "Could not extract details.",
    };
  }
}

// ─── AI: Score candidates against JD ─────────────────────────────────────────
async function scoreCandidatesBatch(candidates, jd) {
  const batchSize = 5;
  const results = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchPromises = batch.map((candidate) =>
      scoreCandidate(candidate, jd)
    );
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

async function scoreCandidate(candidate, jd) {
  const prompt = `You are an expert technical recruiter. Score this candidate against the job description.
Return ONLY valid JSON, no markdown.

JOB DESCRIPTION:
Role: ${jd.role}
Required Skills: ${jd.skills}
Experience Required: ${jd.experience} years
Package: ${jd.package}
Notice Period Acceptable: ${jd.notice}
Other Requirements: ${jd.other || "None"}

CANDIDATE PROFILE:
Name: ${candidate.name}
Experience: ${candidate.total_experience_years} years
Current Role: ${candidate.current_role}
Skills: ${(candidate.skills || []).join(", ")}
Education: ${candidate.education}
Notice Period: ${candidate.notice_period}
Location: ${candidate.current_location}
Summary: ${candidate.summary}

Evaluate and return:
{
  "match_score": <number 0-100>,
  "skill_match": <number 0-100>,
  "experience_match": <number 0-100>,
  "notice_match": <number 0-100>,
  "strengths": ["point1", "point2"],
  "gaps": ["gap1", "gap2"],
  "recommendation": "Strong Match" | "Good Match" | "Moderate Match" | "Weak Match",
  "reasoning": "2-3 sentence explanation"
}`;

  try {
    const content = await generateAIResponse(prompt);
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1].trim();
    const score = JSON.parse(jsonStr);
    return { ...candidate, ...score };
  } catch (err) {
    console.error(`Scoring failed for ${candidate.name}:`, err.message);
    return {
      ...candidate,
      match_score: 0,
      skill_match: 0,
      experience_match: 0,
      notice_match: 0,
      strengths: [],
      gaps: ["Could not process"],
      recommendation: "Unknown",
      reasoning: "Processing failed.",
    };
  }
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
    const { folderId, jd } = req.body;
    
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
    
    const validFiles = driveFiles.filter(f => !f.error);
    
    if (validFiles.length === 0) {
      return res.status(400).json({ error: "No valid resume files found in folder" });
    }
    
    console.log(`Processing ${validFiles.length} resumes...`);
    
    // Extract text from all resumes
    const extractionPromises = validFiles.map(async (file) => {
      const text = await extractText(file.buffer, file.name);
      return { filename: file.name, text };
    });
    const extracted = await Promise.all(extractionPromises);
    
    // Extract candidate info via AI
    const infoPromises = extracted.map(({ text, filename }) =>
      extractCandidateInfo(text, filename)
    );
    const candidates = await Promise.all(infoPromises);
    
    // Score all candidates
    const scored = await scoreCandidatesBatch(candidates, jd);
    
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

    // Step 1: Extract text from all resumes
    console.log(`Processing ${files.length} resumes...`);
    const extractionPromises = files.map(async (file) => {
      const text = await extractText(file.buffer, file.originalname);
      return { filename: file.originalname, text };
    });
    const extracted = await Promise.all(extractionPromises);

    // Step 2: Extract candidate info via AI (batch of 5)
    const infoPromises = extracted.map(({ text, filename }) =>
      extractCandidateInfo(text, filename)
    );
    const candidates = await Promise.all(infoPromises);

    // Step 3: Score all candidates against JD
    const scored = await scoreCandidatesBatch(candidates, jdData);

    // Step 4: Sort by match_score descending
    scored.sort((a, b) => b.match_score - a.match_score);

    // Step 5: Add rank
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
