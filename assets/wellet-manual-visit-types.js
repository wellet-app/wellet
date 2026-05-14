/* eslint-env browser */
// Wellet · manual visit picklist
// ─────────────────────────────────────────────────────────────────────────────
// Care that happens *outside* an EHR system we're connected to — PT, EMG, a
// nutritionist your loved one saw, the UNC ER trip that never showed up in
// Duke's chart. These options seed the "Add outside visit" sheet.
//
// Each entry maps to a FHIR-style encounter class so the timeline card can
// pick the right color (ER red, Inpatient blue, Outpatient green, Virtual gray).
// Class codes follow the v3 ActCode value set Epic uses.
//
//   AMB  = Ambulatory / Outpatient        (green)
//   EMER = Emergency                      (red)
//   IMP  = Inpatient                      (blue)
//   VR   = Virtual                        (gray)
//   HH   = Home health                    (green, treated as outpatient)
//
// If you add a new slug, also surface it in renderManualVisitPickList() and
// (if it's a clinical service that needs its own icon) getEventTypeInfo() in
// wellet.js.

window.WELLET_MANUAL_VISIT_TYPES = [
  {
    section: 'Rehab & therapy',
    items: [
      { slug: 'physical_therapy',    label: 'Physical therapy',    encounter_class: 'AMB', icon: 'activity'        },
      { slug: 'occupational_therapy',label: 'Occupational therapy',encounter_class: 'AMB', icon: 'hand-helping'    },
      { slug: 'speech_therapy',      label: 'Speech therapy',      encounter_class: 'AMB', icon: 'message-circle'  },
      { slug: 'cardiac_rehab',       label: 'Cardiac rehab',       encounter_class: 'AMB', icon: 'heart-pulse'     },
      { slug: 'pulmonary_rehab',     label: 'Pulmonary rehab',     encounter_class: 'AMB', icon: 'wind'            },
    ],
  },
  {
    section: 'Diagnostics outside MyChart',
    items: [
      { slug: 'emg',                 label: 'EMG / nerve conduction', encounter_class: 'AMB', icon: 'zap'           },
      { slug: 'sleep_study',         label: 'Sleep study',            encounter_class: 'AMB', icon: 'moon'          },
      { slug: 'imaging_outside',     label: 'Imaging (outside facility)', encounter_class: 'AMB', icon: 'scan'      },
      { slug: 'lab_outside',         label: 'Lab draw (outside facility)', encounter_class: 'AMB', icon: 'flask-conical' },
      { slug: 'echocardiogram',      label: 'Echocardiogram',         encounter_class: 'AMB', icon: 'heart'         },
      { slug: 'stress_test',         label: 'Stress test',            encounter_class: 'AMB', icon: 'gauge'         },
    ],
  },
  {
    section: 'Specialists & support',
    items: [
      { slug: 'nutritionist',        label: 'Nutritionist / dietitian', encounter_class: 'AMB', icon: 'apple'      },
      { slug: 'mental_health',       label: 'Mental health (therapy/psychiatry)', encounter_class: 'AMB', icon: 'brain' },
      { slug: 'pain_management',     label: 'Pain management',        encounter_class: 'AMB', icon: 'thermometer'   },
      { slug: 'chiropractor',        label: 'Chiropractor',           encounter_class: 'AMB', icon: 'bone'          },
      { slug: 'acupuncture',         label: 'Acupuncture',            encounter_class: 'AMB', icon: 'sparkles'      },
      { slug: 'massage_therapy',     label: 'Massage therapy',        encounter_class: 'AMB', icon: 'hand'          },
      { slug: 'home_health',         label: 'Home health visit',      encounter_class: 'HH',  icon: 'home'          },
      { slug: 'hospice',             label: 'Hospice visit',          encounter_class: 'HH',  icon: 'sun'           },
    ],
  },
  {
    section: 'Routine but separate',
    items: [
      { slug: 'dental',              label: 'Dental',                 encounter_class: 'AMB', icon: 'smile'         },
      { slug: 'vision',              label: 'Vision / optometry',     encounter_class: 'AMB', icon: 'eye'           },
      { slug: 'audiology',           label: 'Audiology',              encounter_class: 'AMB', icon: 'ear'           },
      { slug: 'podiatry',            label: 'Podiatry',               encounter_class: 'AMB', icon: 'footprints'    },
      { slug: 'dermatology',         label: 'Dermatology',            encounter_class: 'AMB', icon: 'shield'        },
    ],
  },
  {
    section: 'Other care',
    items: [
      { slug: 'er_outside',          label: 'ER (outside network)',   encounter_class: 'EMER',icon: 'siren'         },
      { slug: 'urgent_care',         label: 'Urgent care',            encounter_class: 'AMB', icon: 'first-aid'     },
      { slug: 'walk_in_clinic',      label: 'Walk-in clinic',         encounter_class: 'AMB', icon: 'door-open'     },
      { slug: 'second_opinion',      label: 'Second opinion',         encounter_class: 'AMB', icon: 'users'         },
      { slug: 'virtual_visit',       label: 'Virtual / telehealth visit', encounter_class: 'VR', icon: 'video'      },
      { slug: 'other',               label: 'Other…',                 encounter_class: 'AMB', icon: 'plus-circle'   },
    ],
  },
];

// Flat lookup by slug for save + render paths.
window.WELLET_MANUAL_VISIT_BY_SLUG = (function () {
  var map = {};
  window.WELLET_MANUAL_VISIT_TYPES.forEach(function (group) {
    group.items.forEach(function (item) { map[item.slug] = item; });
  });
  return map;
})();

// Encounter class → display label + color token. Mirrors the EHR encounter
// mapper so EHR-sourced and manual visits render identically on the timeline.
window.WELLET_ENCOUNTER_CLASS_INFO = {
  EMER: { label: 'Emergency',  color_token: 'signal-emergency',  hex: '#b34a3c' },  // red
  IMP:  { label: 'Inpatient',  color_token: 'signal-inpatient',  hex: '#3a5a8c' },  // blue
  AMB:  { label: 'Outpatient', color_token: 'signal-outpatient', hex: '#4b6341' },  // moss green
  VR:   { label: 'Virtual',    color_token: 'signal-virtual',    hex: '#6b6b6b' },  // gray
  HH:   { label: 'Home health',color_token: 'signal-outpatient', hex: '#4b6341' },  // moss green
};
