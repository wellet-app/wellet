# transcribe-audio Edge Function

Powers Wellet's doctor visit recording feature. Accepts audio uploads, transcribes via OpenAI Whisper, and extracts structured health data via GPT-4o — all in a single request cycle.

## Pipeline

```
mywellet.com (index.html)
  │
  ├─ 1. User uploads audio file
  ├─ 2. File → Supabase Storage (documents bucket)
  └─ 3. POST /functions/v1/transcribe-audio
         │
         ▼
  transcribe-audio Edge Function
  │
  ├─ 1. Authenticate caller (JWT via anon key)
  ├─ 2. Verify document ownership (documents → people → user_id)
  ├─ 3. Mark document as `processing`
  ├─ 4. Download audio from Storage
  ├─ 5. OpenAI Whisper (whisper-1) → raw transcript
  ├─ 6. GPT-4o structured extraction → JSON
  ├─ 7. Store in documents.extracted_events
  └─ 8. Mark document as `completed`
```

## Accepted Audio Formats

| Format | MIME Type    | Max Size |
|--------|-------------|----------|
| M4A    | audio/mp4   | 25 MB    |
| MP3    | audio/mpeg  | 25 MB    |
| WAV    | audio/wav   | 25 MB    |
| OGG    | audio/ogg   | 25 MB    |
| WEBM   | audio/webm  | 25 MB    |

25 MB is both Wellet's upload limit and the Whisper API file size limit.

## Extraction Fields

GPT-4o extracts structured data from the transcript:

| Type | `type` value | Example title | Example detail |
|------|-------------|---------------|----------------|
| Medication | `medication` | Metformin | 500mg twice daily with meals |
| Condition | `condition` | Type 2 Diabetes | A1C improved to 6.8, down from 7.2 |
| Appointment | `appointment` | Endocrinology follow-up | 3 months, Dr. Smith |
| Lab result | `lab_result` | Comprehensive metabolic panel | Ordered, fasting required |
| Action item | `note` | Pick up prescription | New Metformin Rx at CVS |

### Storage Format

Results stored in `documents.extracted_events` (JSONB):

```json
{
  "transcript": "Full verbatim transcript from Whisper...",
  "summary": "Routine diabetes follow-up. A1C improved. Metformin dose maintained.",
  "items": [
    { "type": "medication", "title": "Metformin", "detail": "500mg twice daily, continued" },
    { "type": "condition", "title": "Type 2 Diabetes", "detail": "A1C 6.8, improved" },
    { "type": "appointment", "title": "Follow-up", "detail": "3 months with Dr. Smith" }
  ]
}
```

## Request / Response

### Request

```
POST https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/transcribe-audio
Authorization: Bearer <user_jwt>
Content-Type: application/json

{
  "document_id": "uuid",
  "storage_path": "user_id/filename.m4a"
}
```

### Success Response

```json
{
  "success": true,
  "transcript": "Full transcript text...",
  "extracted": {
    "transcript": "...",
    "summary": "...",
    "items": [...]
  }
}
```

### Error Responses

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid JWT |
| 403 | Document doesn't belong to this user |
| 400 | Missing document_id or storage_path |
| 404 | Document not found |
| 500 | Whisper API failure or storage download error |

## Security

- **Auth**: Caller must provide valid JWT. Function verifies the document belongs to a person owned by the authenticated user via `people.user_id` join.
- **CORS**: Shared `_shared/cors.ts` — only mywellet.com and getwellet.com origins allowed.
- **PHI**: Audio files stored in the `documents` Storage bucket with RLS policies. Transcripts stored in `extracted_events` with same access controls.
- **Logging**: Errors logged without patient data. Transcript content is never logged.
- **JWT verification**: Disabled at gateway level — function handles auth internally to support custom ownership checks.

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `OPENAI_API_KEY` | Supabase secret — Whisper and GPT-4o |
| `SUPABASE_URL` | Auto-injected |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected — storage download and DB writes |
| `SUPABASE_ANON_KEY` | Auto-injected — user auth verification |
| `_shared/cors.ts` | Shared CORS utility |

## Source Files

```
supabase/functions/transcribe-audio/
└── index.ts          # Entry point
supabase/functions/_shared/
└── cors.ts           # Shared CORS headers
```

## Deployment

Deploy via the Supabase connector's `deploy_edge_function` tool with project ID `nrpdhxygzyfmyljzfexv`. The function name `transcribe-audio` creates a new version automatically.

## Cost

| Component | Cost |
|-----------|------|
| Whisper transcription | ~$0.006/minute of audio |
| GPT-4o extraction | ~$0.01–0.03 per transcript |
| Total per 30-min visit | ~$0.20–0.25 |

## Client-Side Integration

In `index.html`, the audio upload flow:

1. Detects audio file via `isAudioFile()` helper
2. Uploads to Supabase Storage (`documents` bucket)
3. Creates document row with `doc_type: 'doctor_visit_recording'`
4. Calls `transcribe-audio` Edge Function
5. Polls `extraction_status` until `completed` or `failed`
6. Displays transcript + extracted items in the UI
7. Play/stop audio via signed Storage URLs
