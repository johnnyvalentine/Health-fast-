/* ============================================================
   HealthFast — AI-Powered Health Assistant
   Single-file React application (.jsx)
   ============================================================ */

const { useState, useEffect, useRef, useCallback } = React;

// ─── Utility helpers ────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function storage(key, value) {
  if (arguments.length === 1) {
    try {
      const raw = window.storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  window.storage.setItem(key, JSON.stringify(value));
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Severity helpers ───────────────────────────────────────
const SEVERITY_CONFIG = {
  "non-urgent": {
    label: "Non-Urgent",
    bg: "bg-green-50",
    border: "border-green-300",
    text: "text-green-800",
    badge: "bg-green-100 text-green-800",
    icon: "✓",
  },
  urgent: {
    label: "Urgent",
    bg: "bg-amber-50",
    border: "border-amber-300",
    text: "text-amber-800",
    badge: "bg-amber-100 text-amber-800",
    icon: "⚠",
  },
  emergency: {
    label: "Emergency",
    bg: "bg-red-50",
    border: "border-red-400",
    text: "text-red-800",
    badge: "bg-red-100 text-red-800",
    icon: "🚨",
  },
};

function getSeverityConfig(severity) {
  const key = (severity || "").toLowerCase().replace(/[\s-_]/g, "-");
  return SEVERITY_CONFIG[key] || SEVERITY_CONFIG["non-urgent"];
}

// ─── API: Anthropic ─────────────────────────────────────────
async function analyzeHealth(textInput, imageBase64, userProfile) {
  const profileContext = userProfile
    ? `Patient context — Name: ${userProfile.fullName}, DOB: ${userProfile.dob}, City: ${userProfile.city}, State: ${userProfile.state}, Known allergies: ${userProfile.allergies || "None reported"}, Pre-existing conditions: ${userProfile.conditions || "None reported"}.`
    : "";

  const systemPrompt = `You are a medical health analysis assistant. Analyze the user's symptoms or health concern and return a JSON object with exactly these keys:
- "conditions": array of strings — possible conditions (2-5 items)
- "severity": one of "non-urgent", "urgent", or "emergency"
- "next_steps": array of strings — recommended actions (2-5 items)
- "immediate_care": string — when to seek immediate care (1-2 sentences)
- "summary": string — brief plain-language overview of the analysis (2-3 sentences)

${profileContext}

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no extra text.
Be thorough but cautious — when uncertain, lean toward higher severity.
Always remind that this is not a substitute for professional medical advice.`;

  const content = [];
  if (imageBase64) {
    const mediaType = imageBase64.startsWith("data:image/png")
      ? "image/png"
      : imageBase64.startsWith("data:image/gif")
        ? "image/gif"
        : imageBase64.startsWith("data:image/webp")
          ? "image/webp"
          : "image/jpeg";
    const base64Data = imageBase64.split(",")[1] || imageBase64;
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64Data },
    });
  }
  content.push({
    type: "text",
    text: textInput || "Please analyze the uploaded image for any visible health concerns.",
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response.");
  return JSON.parse(jsonMatch[0]);
}

// ─── API: Nearby places (OpenStreetMap Nominatim fallback) ──
async function fetchNearbyPlaces(lat, lon) {
  const categories = [
    { type: "pharmacy", label: "Pharmacy" },
    { type: "doctors", label: "Doctor" },
    { type: "clinic", label: "Urgent Care" },
    { type: "hospital", label: "Hospital" },
  ];

  const results = [];
  for (const cat of categories) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=3&q=${encodeURIComponent(cat.type)}&viewbox=${lon - 0.05},${lat + 0.05},${lon + 0.05},${lat - 0.05}&bounded=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "HealthFast/1.0" },
      });
      if (res.ok) {
        const places = await res.json();
        for (const p of places) {
          results.push({
            name: p.display_name.split(",")[0],
            address: p.display_name.split(",").slice(1, 4).join(",").trim(),
            type: cat.label,
            distance: distanceKm(lat, lon, parseFloat(p.lat), parseFloat(p.lon)),
            lat: p.lat,
            lon: p.lon,
            mapsLink: `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`,
          });
        }
      }
    } catch {
      /* skip failed category */
    }
  }
  return results.sort((a, b) => a.distance - b.distance).slice(0, 8);
}

// ─── Components ─────────────────────────────────────────────

// --- Disclaimer Banner ---
function Disclaimer() {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-xs text-blue-700 text-center">
      ⓘ This app provides general health information only and is not a substitute for professional medical advice.
    </div>
  );
}

// --- Emergency Banner ---
function EmergencyBanner() {
  return (
    <div className="bg-red-600 text-white rounded-xl p-4 text-center shadow-lg animate-pulse">
      <div className="text-2xl font-bold mb-1">🚨 EMERGENCY DETECTED</div>
      <p className="text-sm mb-3">
        This may be a life-threatening situation. Call emergency services immediately.
      </p>
      <a
        href="tel:911"
        className="inline-block bg-white text-red-600 font-bold px-8 py-3 rounded-full text-lg shadow hover:bg-red-50 transition"
      >
        📞 Call 911
      </a>
    </div>
  );
}

// --- Loading Spinner ---
function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-4" />
      <p className="text-slate-500 text-sm">Analyzing your health concern...</p>
      <p className="text-slate-400 text-xs mt-1">This may take a moment</p>
    </div>
  );
}

// --- Nearby Places List ---
function NearbyPlaces({ places, loading }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
        <div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
        Finding nearby medical facilities...
      </div>
    );
  }
  if (!places || places.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="font-semibold text-slate-700 mb-2 text-sm">Nearby Medical Facilities</h4>
      <div className="space-y-2">
        {places.map((p, i) => (
          <a
            key={i}
            href={p.mapsLink}
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-white border border-slate-200 rounded-lg p-3 hover:border-blue-300 hover:shadow transition"
          >
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 text-sm truncate">{p.name}</div>
                <div className="text-xs text-slate-500 truncate">{p.address}</div>
              </div>
              <div className="flex flex-col items-end ml-2 shrink-0">
                <span className="text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                  {p.type}
                </span>
                <span className="text-xs text-slate-400 mt-1">
                  {p.distance.toFixed(1)} km
                </span>
              </div>
            </div>
            <div className="text-xs text-blue-500 mt-1">Open in Maps →</div>
          </a>
        ))}
      </div>
    </div>
  );
}

// --- Analysis Result Card ---
function AnalysisResult({ result, places, placesLoading, onFindNearby }) {
  const sev = getSeverityConfig(result.severity);
  const isEmergency = result.severity?.toLowerCase() === "emergency";
  const isUrgentOrEmergency =
    result.severity?.toLowerCase() === "urgent" ||
    result.severity?.toLowerCase() === "emergency";

  return (
    <div className="space-y-4">
      {isEmergency && <EmergencyBanner />}

      {/* Severity Badge */}
      <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${sev.bg} border ${sev.border}`}>
        <span className="text-lg">{sev.icon}</span>
        <span className={`font-semibold text-sm ${sev.text}`}>
          Severity: {sev.label}
        </span>
      </div>

      {/* Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h4 className="font-semibold text-slate-700 text-sm mb-2">Summary</h4>
        <p className="text-slate-600 text-sm leading-relaxed">{result.summary}</p>
      </div>

      {/* Possible Conditions */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h4 className="font-semibold text-slate-700 text-sm mb-2">Possible Conditions</h4>
        <ul className="space-y-1">
          {(result.conditions || []).map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
              <span className="text-blue-400 mt-0.5">•</span>
              {c}
            </li>
          ))}
        </ul>
      </div>

      {/* Recommended Next Steps */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h4 className="font-semibold text-slate-700 text-sm mb-2">Recommended Next Steps</h4>
        <ol className="space-y-1">
          {(result.next_steps || []).map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
              <span className="bg-blue-100 text-blue-700 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
      </div>

      {/* When to Seek Immediate Care */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <h4 className="font-semibold text-amber-800 text-sm mb-1">When to Seek Immediate Care</h4>
        <p className="text-amber-700 text-sm">{result.immediate_care}</p>
      </div>

      {/* Find Nearby — only for urgent/emergency */}
      {isUrgentOrEmergency && !places && !placesLoading && (
        <button
          onClick={onFindNearby}
          className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 transition text-sm"
        >
          📍 Find Nearby Medical Facilities
        </button>
      )}

      <NearbyPlaces places={places} loading={placesLoading} />
    </div>
  );
}

// --- Sign-Up / Profile Form ---
function ProfileForm({ profile, onSave }) {
  const [form, setForm] = useState(
    profile || {
      fullName: "",
      email: "",
      phone: "",
      dob: "",
      city: "",
      state: "",
      allergies: "",
      conditions: "",
    }
  );
  const [saved, setSaved] = useState(false);

  const set = (field, val) => {
    setForm((p) => ({ ...p, [field]: val }));
    setSaved(false);
  };

  const save = () => {
    if (!form.fullName || !form.email || !form.phone || !form.dob || !form.city || !form.state) {
      alert("Please fill in all required fields.");
      return;
    }
    onSave(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputCls =
    "w-full px-3 py-2.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition";

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Full Name *</label>
        <input
          className={inputCls}
          placeholder="John Doe"
          value={form.fullName}
          onChange={(e) => set("fullName", e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Email *</label>
          <input
            className={inputCls}
            type="email"
            placeholder="you@email.com"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Phone *</label>
          <input
            className={inputCls}
            type="tel"
            placeholder="(555) 123-4567"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date of Birth *</label>
          <input
            className={inputCls}
            type="date"
            value={form.dob}
            onChange={(e) => set("dob", e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">City *</label>
          <input
            className={inputCls}
            placeholder="City"
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">State *</label>
          <input
            className={inputCls}
            placeholder="State"
            value={form.state}
            onChange={(e) => set("state", e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Known Allergies</label>
        <textarea
          className={inputCls + " resize-none"}
          rows={2}
          placeholder="e.g., Penicillin, Peanuts, Latex"
          value={form.allergies}
          onChange={(e) => set("allergies", e.target.value)}
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Pre-existing Conditions</label>
        <textarea
          className={inputCls + " resize-none"}
          rows={2}
          placeholder="e.g., Asthma, Diabetes, Hypertension"
          value={form.conditions}
          onChange={(e) => set("conditions", e.target.value)}
        />
      </div>
      <button
        onClick={save}
        className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 transition text-sm"
      >
        {saved ? "✓ Saved!" : profile ? "Update Profile" : "Create Account"}
      </button>
    </div>
  );
}

// --- History Entry Card ---
function HistoryCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const sev = getSeverityConfig(entry.severity);

  return (
    <div
      className="bg-white border border-slate-200 rounded-xl overflow-hidden cursor-pointer hover:border-slate-300 transition"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="p-4">
        <div className="flex items-start justify-between mb-1">
          <span className="text-xs text-slate-400">{formatDate(entry.timestamp)}</span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${sev.badge}`}>
            {sev.icon} {sev.label}
          </span>
        </div>
        <p className="text-sm text-slate-700 line-clamp-2 mt-1">
          {entry.symptoms || "Image-based analysis"}
        </p>
        {entry.imageBase64 && (
          <div className="mt-2 w-12 h-12 rounded-lg overflow-hidden border border-slate-100">
            <img src={entry.imageBase64} alt="" className="w-full h-full object-cover" />
          </div>
        )}
      </div>

      {expanded && entry.aiResponse && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50 space-y-3">
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1">Summary</div>
            <p className="text-sm text-slate-600">{entry.aiResponse.summary}</p>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1">Possible Conditions</div>
            <ul className="text-sm text-slate-600">
              {(entry.aiResponse.conditions || []).map((c, i) => (
                <li key={i}>• {c}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1">Next Steps</div>
            <ol className="text-sm text-slate-600">
              {(entry.aiResponse.next_steps || []).map((s, i) => (
                <li key={i}>
                  {i + 1}. {s}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1">Immediate Care</div>
            <p className="text-sm text-slate-600">{entry.aiResponse.immediate_care}</p>
          </div>
          {entry.location && (
            <div className="text-xs text-slate-400">
              📍 Location: {entry.location.lat.toFixed(4)}, {entry.location.lon.toFixed(4)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tab Icons ──────────────────────────────────────────────
function HomeIcon({ active }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke={active ? "#2563eb" : "#94a3b8"} strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
    </svg>
  );
}

function HistoryIcon({ active }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke={active ? "#2563eb" : "#94a3b8"} strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ProfileIcon({ active }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke={active ? "#2563eb" : "#94a3b8"} strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  );
}

// ─── Main App ───────────────────────────────────────────────
function App() {
  // State
  const [tab, setTab] = useState("home");
  const [profile, setProfile] = useState(() => storage("hf_profile"));
  const [history, setHistory] = useState(() => storage("hf_history") || []);
  const [inputMode, setInputMode] = useState("text"); // "text" | "image"
  const [symptoms, setSymptoms] = useState("");
  const [imageBase64, setImageBase64] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [places, setPlaces] = useState(null);
  const [placesLoading, setPlacesLoading] = useState(false);
  const fileRef = useRef(null);
  const scrollRef = useRef(null);

  // Persist profile and history
  useEffect(() => {
    if (profile) storage("hf_profile", profile);
  }, [profile]);

  useEffect(() => {
    storage("hf_history", history);
  }, [history]);

  // Handle image upload
  const handleImageUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please upload a valid image file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Image must be under 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImageBase64(ev.target.result);
      setImagePreview(ev.target.result);
      setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  // Clear inputs
  const clearInputs = () => {
    setSymptoms("");
    setImageBase64(null);
    setImagePreview(null);
    setResult(null);
    setPlaces(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  // Submit health query
  const handleSubmit = async () => {
    if (!symptoms.trim() && !imageBase64) {
      setError("Please describe your symptoms or upload an image.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setPlaces(null);

    try {
      const aiResult = await analyzeHealth(symptoms.trim(), imageBase64, profile);
      setResult(aiResult);

      // Get location for logging
      let location = null;
      try {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
        );
        location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch {
        /* location not available */
      }

      // Save to history
      const entry = {
        id: uid(),
        timestamp: new Date().toISOString(),
        symptoms: symptoms.trim(),
        imageBase64: imageBase64 || null,
        aiResponse: aiResult,
        severity: aiResult.severity,
        location,
      };
      setHistory((prev) => [entry, ...prev]);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Find nearby facilities
  const handleFindNearby = async () => {
    setPlacesLoading(true);
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const results = await fetchNearbyPlaces(pos.coords.latitude, pos.coords.longitude);
      setPlaces(results);
    } catch {
      setError("Unable to get your location. Please enable location services and try again.");
    } finally {
      setPlacesLoading(false);
    }
  };

  // Save profile
  const handleSaveProfile = (data) => {
    setProfile(data);
  };

  // Sign out
  const handleSignOut = () => {
    setProfile(null);
    setHistory([]);
    window.storage.removeItem("hf_profile");
    window.storage.removeItem("hf_history");
    setTab("home");
    clearInputs();
  };

  // ── Render ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-green-50 flex flex-col">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur border-b border-slate-100 px-4 py-3 sticky top-0 z-30">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-green-400 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              H+
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-800 leading-tight">HealthFast</h1>
              <p className="text-[10px] text-slate-400 -mt-0.5">AI Health Assistant</p>
            </div>
          </div>
          {profile && (
            <div className="text-right">
              <div className="text-xs font-medium text-slate-600">{profile.fullName}</div>
              <div className="text-[10px] text-slate-400">{profile.city}, {profile.state}</div>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-24" ref={scrollRef}>
        <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
          <Disclaimer />

          {/* ─── HOME TAB ────────────────────── */}
          {tab === "home" && (
            <>
              {!profile ? (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <h2 className="text-xl font-bold text-slate-800">Welcome to HealthFast</h2>
                    <p className="text-sm text-slate-500 mt-1">
                      Create your profile to get started with personalized health analysis.
                    </p>
                  </div>
                  <ProfileForm profile={null} onSave={handleSaveProfile} />
                </div>
              ) : (
                <>
                  {/* Input Mode Toggle */}
                  <div className="flex bg-slate-100 rounded-xl p-1">
                    <button
                      onClick={() => setInputMode("text")}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                        inputMode === "text"
                          ? "bg-white text-blue-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      Describe Symptoms
                    </button>
                    <button
                      onClick={() => setInputMode("image")}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                        inputMode === "image"
                          ? "bg-white text-blue-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      Upload Photo
                    </button>
                  </div>

                  {/* Text Input */}
                  {inputMode === "text" && (
                    <div>
                      <textarea
                        className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition resize-none"
                        rows={5}
                        placeholder="Describe your symptoms, how you're feeling, or any health concerns in detail..."
                        value={symptoms}
                        onChange={(e) => setSymptoms(e.target.value)}
                      />
                    </div>
                  )}

                  {/* Image Upload */}
                  {inputMode === "image" && (
                    <div className="space-y-3">
                      <div
                        onClick={() => fileRef.current?.click()}
                        className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition"
                      >
                        {imagePreview ? (
                          <div className="space-y-2">
                            <img
                              src={imagePreview}
                              alt="Preview"
                              className="max-h-48 mx-auto rounded-lg shadow"
                            />
                            <p className="text-xs text-slate-400">Click to change image</p>
                          </div>
                        ) : (
                          <div>
                            <div className="text-3xl mb-2">📷</div>
                            <p className="text-sm text-slate-500">Click to upload a photo</p>
                            <p className="text-xs text-slate-400 mt-1">
                              JPG, PNG, GIF, or WebP — max 10 MB
                            </p>
                          </div>
                        )}
                        <input
                          ref={fileRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleImageUpload}
                        />
                      </div>
                      <textarea
                        className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition resize-none"
                        rows={3}
                        placeholder="(Optional) Add context about the image..."
                        value={symptoms}
                        onChange={(e) => setSymptoms(e.target.value)}
                      />
                    </div>
                  )}

                  {/* Error */}
                  {error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  {/* Action Buttons */}
                  {!loading && !result && (
                    <button
                      onClick={handleSubmit}
                      disabled={!symptoms.trim() && !imageBase64}
                      className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm"
                    >
                      Analyze Health Concern
                    </button>
                  )}

                  {/* Loading */}
                  {loading && <LoadingSpinner />}

                  {/* Result */}
                  {result && (
                    <div className="space-y-4">
                      <AnalysisResult
                        result={result}
                        places={places}
                        placesLoading={placesLoading}
                        onFindNearby={handleFindNearby}
                      />
                      <button
                        onClick={clearInputs}
                        className="w-full bg-slate-100 text-slate-600 font-medium py-3 rounded-xl hover:bg-slate-200 transition text-sm"
                      >
                        New Analysis
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ─── HISTORY TAB ─────────────────── */}
          {tab === "history" && (
            <>
              <h2 className="text-lg font-bold text-slate-800">Health History</h2>
              {!profile ? (
                <div className="text-center py-12">
                  <div className="text-4xl mb-2">📋</div>
                  <p className="text-sm text-slate-500">Create a profile to start tracking your health history.</p>
                </div>
              ) : history.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-4xl mb-2">📋</div>
                  <p className="text-sm text-slate-500">No health queries yet.</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Your analysis history will appear here.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map((entry) => (
                    <HistoryCard key={entry.id} entry={entry} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ─── PROFILE TAB ─────────────────── */}
          {tab === "profile" && (
            <>
              <h2 className="text-lg font-bold text-slate-800">
                {profile ? "Your Profile" : "Create Profile"}
              </h2>

              {profile && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 mb-2">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-400 to-green-400 rounded-full flex items-center justify-center text-white font-bold text-lg">
                      {profile.fullName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-800">{profile.fullName}</div>
                      <div className="text-xs text-slate-400">{profile.email}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
                    <div>
                      <span className="font-medium text-slate-600">Phone:</span> {profile.phone}
                    </div>
                    <div>
                      <span className="font-medium text-slate-600">DOB:</span> {profile.dob}
                    </div>
                    <div>
                      <span className="font-medium text-slate-600">Location:</span> {profile.city}, {profile.state}
                    </div>
                    <div>
                      <span className="font-medium text-slate-600">Queries:</span> {history.length}
                    </div>
                  </div>
                  {profile.allergies && (
                    <div className="text-xs text-slate-500 pt-1">
                      <span className="font-medium text-slate-600">Allergies:</span> {profile.allergies}
                    </div>
                  )}
                  {profile.conditions && (
                    <div className="text-xs text-slate-500">
                      <span className="font-medium text-slate-600">Conditions:</span> {profile.conditions}
                    </div>
                  )}
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <h3 className="font-semibold text-slate-700 text-sm mb-3">
                  {profile ? "Edit Profile" : "Sign Up"}
                </h3>
                <ProfileForm profile={profile} onSave={handleSaveProfile} />
              </div>

              {profile && (
                <button
                  onClick={handleSignOut}
                  className="w-full border border-red-200 text-red-500 font-medium py-3 rounded-xl hover:bg-red-50 transition text-sm"
                >
                  Sign Out & Clear Data
                </button>
              )}
            </>
          )}
        </div>
      </main>

      {/* Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t border-slate-100 z-30">
        <div className="max-w-lg mx-auto flex">
          {[
            { id: "home", label: "Home", Icon: HomeIcon },
            { id: "history", label: "History", Icon: HistoryIcon },
            { id: "profile", label: "Profile", Icon: ProfileIcon },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition ${
                tab === id ? "text-blue-600" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <Icon active={tab === id} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ─── Render ─────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
