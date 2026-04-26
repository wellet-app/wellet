// Adapter composition root.
//
// This file is the ONLY place where individual hospital adapters are
// imported and wired into the registry. The handler in ../index.ts
// imports from here, never from a specific adapter — that keeps the
// registry as the single source of truth for "which hospitals are we
// enriching today?" and prevents drive-by additions that bypass the
// router.
//
// Adding a new hospital is mechanical:
//   1. Add ./<hospital>.ts implementing HospitalDirectoryAdapter.
//   2. Import it here.
//   3. Push it to the registry below.
//   4. Add a row in wellet_directory_enricher_targets.csv.
//
// Order does not matter — runDirectoryLookup picks adapters whose
// fhir_domains or hint_org_keywords match the input, never falls back
// to "the first adapter we have".

import { registerAdapter } from "../../_shared/hospital-directory-registry.ts";
import { dukeAdapter } from "./duke.ts";

registerAdapter(dukeAdapter);

// Future adapters land here:
//   import { uncAdapter } from "./unc.ts";          registerAdapter(uncAdapter);
//   import { wakemedAdapter } from "./wakemed.ts";  registerAdapter(wakemedAdapter);
//   import { coneAdapter } from "./cone.ts";        registerAdapter(coneAdapter);
//   import { atriumAdapter } from "./atrium.ts";    registerAdapter(atriumAdapter);
