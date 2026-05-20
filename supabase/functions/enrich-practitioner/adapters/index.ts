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
import { uncAdapter } from "./unc.ts";
import { wakemedAdapter } from "./wakemed.ts";
import { nyuAdapter } from "./nyu.ts";

registerAdapter(dukeAdapter);
registerAdapter(uncAdapter);
registerAdapter(wakemedAdapter);
registerAdapter(nyuAdapter);

// Future adapters land here:
//   import { clevelandAdapter } from "./cleveland.ts";  registerAdapter(clevelandAdapter);
//   import { mayoAdapter } from "./mayo.ts";            registerAdapter(mayoAdapter);
//   import { mgbAdapter } from "./mgb.ts";              registerAdapter(mgbAdapter);
//   import { stanfordAdapter } from "./stanford.ts";    registerAdapter(stanfordAdapter);
