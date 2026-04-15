# Wellet C-CDA Test Fixtures

Synthetic C-CDA XML files that replicate the Epic MyChart quirks found in a real Duke Health export. Use these for automated testing of the C-CDA parser without requiring real patient data.

## Structure

```
wellet-ccda-test-fixtures/
├── README.md
├── IHE_XDM/                          ← Epic's IHE Cross-Enterprise Document Media format
│   └── TestPatient1/
│       ├── DOC0001.XML               ← Patient Health Summary (C-CDA R2.1)
│       ├── DOC0002.XML               ← Summary of Care (continuity document)
│       └── DOC0003.XML               ← Minimal/edge-case document
├── standalone/
│   ├── cerner-format.xml             ← Non-IHE_XDM layout (Cerner-style)
│   └── empty-sections.xml           ← Valid CDA with no clinical data
└── expected/
    └── doc0001-expected.json         ← Expected parser output for DOC0001.XML
```

## Epic Quirks Replicated

### 1. `originalText/reference` Pattern (Medications)
Epic does NOT put medication display names in the `displayName` attribute of `<code>`. Instead:
```xml
<manufacturedMaterial>
  <code code="991061" codeSystem="2.16.840.1.113883.6.88" codeSystemName="RxNorm">
    <originalText>
      <reference value="#med5" />    ← Points to narrative <text> section
    </originalText>
  </code>
</manufacturedMaterial>
```
The parser must resolve `#med5` back to the narrative section's `<content ID="med5">` element.

### 2. Allergy Encoding Garbage
Epic puts the allergen name, reaction, and severity into the narrative `<text>` section but the structured `<observation>` entries use generic SNOMED codes like "Propensity to adverse reactions to drug" (419511003) instead of the specific allergen substance. The allergy observation's `<participant>` may have a `<code>` with an RxNorm code for the substance, but the `displayName` is often missing or generic.

Result: naive parsers extract "Active", "Other (See Comments)", or "low criticality" as allergen names.

### 3. IHE_XDM Folder Structure
Real Epic MyChart exports use `IHE_XDM/PatientName1/` folder layout, NOT flat XML files. The ZIP handler must walk into subdirectories.

### 4. 49 Documents per Export
A single MyChart export may contain dozens of CDA XML files — a Patient Health Summary plus one Summary of Care per encounter. Many share overlapping medication and allergy sections. The parser must deduplicate.

### 5. Narrative `<text>` Has HTML-like Structure
Epic's narrative sections use `<list>`, `<item>`, `<content>`, `<paragraph>` elements with `ID` attributes and `styleCode` for formatting. This is the source of truth for display names when structured entries use reference pointers.

## Test Patient

- **Name:** Jane TestPatient (synthetic)
- **DOB:** 1950-01-15
- **MRN:** TEST-12345
- **Conditions:** Hypertension, Type 2 Diabetes
- **Medications:** 5 (including one with originalText/reference pattern)
- **Allergies:** 2 (one well-formed, one with the garbage encoding)
- **Labs:** CBC, BMP, HbA1c
- **Vitals:** BP, HR, Weight, BMI
