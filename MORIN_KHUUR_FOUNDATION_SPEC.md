# Mongolian Morin Khuur (Морин хуур) Simulator & Open-Source Cultural Preservation Architecture
*Comprehensive Technical & Domain Foundation Specification*

---

## 1. Cultural Mission & Open-Source Heritage

The **Morin Khuur** (Horsehead Fiddle) is recognized by UNESCO as a **Masterpiece of the Oral and Intangible Heritage of Humanity**. For centuries, it has captured the soul, history, and spiritual connection of the Mongolian nomadic people to the steppes and their horses.

This project unifies acoustic physics, modern beat-making production, and pedagogical expertise from initiatives like **UUGUUL** ([uuguul.com/learn/morin-khuur/](https://uuguul.com/learn/morin-khuur/)) into a 100% free, open-source educational platform.

### Core Goals:
1. **Cultural Preservation & Global Introduction**: Digitally preserve ancestral playing techniques, terminology, and repertoire (*Tatlaga*, *Bii biyelgee*, *Urtiin Duu*) so anyone in the world can experience and learn the instrument authentically.
2. **Interactive Beat Maker & Modern Fusion Playground**: Enable producers and beatmakers to blend traditional Morin Khuur articulations (Col Legno strikes, body knocks, horse whinnies, galloping 6/8 swing) with modern genres (Lo-Fi, Trap, Hip-Hop, Folk Metal, Cinematic Film Scores).
3. **Automated Song Testing & Educational Validator**: Provide a notation playback engine where entering song notes (e.g., *"Ulemjiin Chanar"*, *"Joroo Mori"*, *"Eej Mini"*) accurately animates the instrument with correct side-fingernail placement, thumb positions, and bow strokes.
4. **100% Free & Open-Source (FOSS)**: Permissive open-source foundation (MIT / Apache 2.0) with modular libraries for global community contribution.

---

## 2. 3D Model Anatomy & Visual Reference

Based on authentic instruments and 3D reference ([Sketchfab Morin Khuur 68ee30b5](https://sketchfab.com/3d-models/morin-khuur-68ee30b5a2ad4ec68389d73b42d46c7e)):

```
            [ Matgar Tolgoi ] -> Carved Horse Head Scroll
                   |
            [ Chikhi (2) ]   -> Two Wooden Tuning Pegs (Male on left, Female on right)
                   |
            [ Deed Teew ]    -> Upper Nut
                   |
            [ Khüzüü ]       -> Neck (WITHOUT fingerboard; hollow space behind strings)
            * Strings hover  * Left hand stops from the SIDE with fingernails/cuticles
                   |
           [ Gashaa / Hairtsag ] -> Trapezoidal Wooden Soundbox
             - Urd mod       -> Soundboard face with traditional carved F-holes
             - Teew          -> Floating Wooden Bridge
             - Kharuul       -> Wooden Tailpiece anchoring string ends
                   |
            [ Khuuryn Num ]  -> Curved Bow with horsehair ribbon & underhand grip
```

### Key Physical Constraints to Model:
* **No Fingerboard**: Unlike violins, guitars, or cellos, strings **do not touch wood**. They hover freely in the air.
* **Side-Stopping**: The strings are stopped by pressing against the **side** with the fingernails or cuticle groove (index, middle, ring, pinky), never pressed down.
* **Thumb Playing (*Erkhii darakh*)**: The thumb hooks underneath the male string to stop high-register notes and stabilize higher-octave shifts.
* **Two Asymmetric Strings**:
  * **Arga (Male string / Bass)**: Left side (from player perspective), wound from ~130 stallion tail hairs. Standard pitch: **F3** (or C3/G3 in traditional folk tunings).
  * **Bilag (Female string / Treble)**: Right side, wound from ~105 mare tail hairs. Standard pitch: **B♭3** (or G3/C4).
* **Underhand Bow Grip**: Held palm-up; the middle and ring fingers push outward directly against the horsehairs to dynamically modulate bow hair tension in real time.

---

## 3. Comprehensive 2-String Technique Spectrum & UUGUUL Pedagogical Syllabus

The Morin Khuur achieves an astonishingly expressive sonic vocabulary on only two strings. The simulator engine models every traditional and extended articulation:

| # | Technique | Mongolian Name | Mechanics & Sound Characteristics | Simulator Trigger / Control |
|---|---|---|---|---|
| **1** | **Col Legno (Bow Stick Hit)** | *Numny modoor tsoxikh* | Striking the string with the **wooden stick** of the bow instead of hair. Produces a sharp, dry, percussive click. Essential for modern folk-rock (The HU) and galloping rhythms. | Beat pad / Key `C` / Downward flick gesture |
| **2** | **Body Percussion (Soundboard Tap)** | *Hairtsag tsoxikh* | Tapping or knocking the wooden/hide soundbox (*gashaa*) with knuckles or fingertips. Simulates galloping horse hooves (*doroo*). | Beat pad / Key `T` / Tap on soundbox body |
| **3** | **String Slap / Snap** | *Utas tsoxikh* | Slapping or snapping the hovering string with fingertips for an aggressive rhythmic attack. | Beat pad / Key `X` / Quick downward tap |
| **4** | **Horse Whinny Imitation** | *Moriin insee* | Sliding the fingernail rapidly up to the high register while performing rapid tremolo bowing and accenting. Iconic Mongolian solo centerpiece. | Special FX Pad / Key `W` / Slide gesture + flutter |
| **5** | **Natural Harmonics** | *Tsatsal* | Lightly touching string nodes (1/2 octave, 1/3 fifth, 1/4 fourth, 1/5 major third) without stopping the string against the cuticle. Produces bell-like, ethereal, flute-like overtones. | Harmonic trigger / Key `Shift` + note |
| **6** | **Artificial Harmonics** | *Khuuramch tsatsal* | Stopping a fundamental note with the cuticle and lightly brushing a higher node with another finger. | Multi-touch / Polyphonic key combo |
| **7** | **Pizzicato (Pluck)** | *Huruugaar tatakh* | Plucking either the Arga or Bilag string using the right-hand index finger or left-hand thumb. Crisp, lute-like pluck with woody decay. | Beat pad / Key `P` / Click on string |
| **8** | **Pull Stroke (Down-Bow)** | *Tatakh* | Pulling the bow towards the right. Heavy attack, warm, resonant fundamental tone. | Bow Pad drag right / Key `Right Arrow` |
| **9** | **Push Stroke (Up-Bow)** | *Tülekhe* | Pushing the bow towards the left. Lighter, brighter, crisp articulation. | Bow Pad drag left / Key `Left Arrow` |
| **10** | **Galloping Bowing** | *Morin Joroo* | Rapid 3-note or 4-note rhythmic bowing patterns (triplet down-up-up or dotted eighth-sixteenth) mimicking horse gaits. | 6/8 Gallop pattern engine / Looper |
| **11** | **Vibrato** | *Chichiree* | Rocking the fingernail back and forth on the string cuticle contact point. Deep, emotive microtonal pitch modulation. | Modulation wheel / Mouse Y-axis |
| **12** | **Tremolo / Shimmer** | *Dalallaga* | Extremely rapid alternation of push and pull strokes at the bow tip. Generates a shimmering wall of steppe overtones. | Tremolo hold button / Key `Space` |
| **13** | **Smooth Glissando** | *Gulsuulakh* | Seamless, lyrical legato slide between pitches along the vibrating string. Fundamental to *Urtiin Duu* (Long Songs). | Legato pitch glide / Continuous touch slide |
| **14** | **Whipped Glissando** | *Shuvtrakh* | Fast, sharp stripping or whipping slide across positions for dramatic effect. | Quick directional swipe |
| **15** | **Trembling Glissando** | *Shigshikh* | Shaking, trembling slide that combines vibrato micro-shakes while shifting position. | Modulated touch glide |
| **16** | **Finger Strike Articulation** | *Tsokhilgo* | Rhythmic percussion generated by snapping the left-hand fingers sharply onto the string. | Key velocity / Percussive tap |
| **17** | **Thumb Playing** | *Erkhii darakh* | Using the thumb underneath the male string to reach extended intervals and high 4th-octave registers. | Shift / Thumb toggle pad |
| **18** | **Double-Stop Drone Bowing** | *Khos utas zereg* | Bowing **both** Male and Female strings simultaneously. The Male string acts as a deep pedal drone while the Female string plays the melody. | Double-string toggle / Both keys pressed |
| **19** | **Sul Ponticello (At Bridge)** | *Teewiin oir tatakh* | Bowing directly against the bridge. Creates a raspy, harsh, harmonic-rich overtone timbre. | Bow position slider near bridge |
| **20** | **Sul Tasto (Near Neck)** | *Khüzüüni oir tatakh* | Bowing high up near the neck. Creates a soft, warm, airy, flute-like timbre. | Bow position slider near neck |

---

## 4. Beat Maker & Modern Music Production Engine

```
┌────────────────────────────────────────────────────────────────────────┐
│                   BEAT MAKER / PRODUCTION ENGINE                       │
├──────────────────────────────┬─────────────────────────────────────────┤
│    4x4 MPC-Style Beat Grid   │        16/32 Step Pattern Sequencer     │
│  - Col Legno (Bow Hit)       │  - 6/8 Mongolian Joroo (Gallop swing)   │
│  - Soundboard Knuckle Tap    │  - 4/4 Modern Hip-Hop / Trap / Lo-Fi    │
│  - Horse Whinny (Insee)      │  - Velocity & Pitch Step Modulator      │
│  - Male/Female Open Strings  │  - Real-time Pattern Chaining           │
│  - Tsatsal Harmonics         │  - Export loop to WAV / MIDI            │
│  - 808 Sub-Bass & Kick       │                                         │
│  - Mongolian Shamanic Drum   │                                         │
└──────────────────────────────┴─────────────────────────────────────────┘
```

### Key Production Capabilities:
* **Galloping Swing Quantize**: Traditional Mongolian rhythms are built on galloping horse gaits (*Joroo* - 6/8 triplet trot, *Töwöö* - dotted trot). The sequencer includes authentic horse-swing presets.
* **Morin Khuur Percussion Kit**: Use the physical fiddle as a complete percussion section (Col Legno stick hits for snare/rimshot, soundboard knocks for kick/tom, string scratches for hi-hats).
* **Sample Slicing & One-Shots**: Instant capture of custom Morin Khuur licks into sliceable pads.

---

## 5. Song Player & Automated Notation Verification Engine

### 5.1 Verification Principle
To prove the simulator is 100% physically and acoustically authentic:
> **"We give it notes of songs, and if it plays accurately on the Morin Khuur — with correct side-fingernail placement, thumb position, string selection, and push/pull bowing — it passes."**

### 5.2 Notation Format Specification (`.mkhuur.json`)
A lightweight, open JSON format supporting both Western staff notation and Asian numbered musical notation (*Jianpu*):

```json
{
  "title": "Ulemjiin Chanar (The Quality of Perfection)",
  "composer": "Danzanravjaa",
  "genre": "Urtiin Duu",
  "tuning": {
    "maleString": "F3",
    "femaleString": "Bb3"
  },
  "tempoBpm": 92,
  "timeSignature": "4/4",
  "notes": [
    {
      "time": "0:0:0",
      "pitch": "F3",
      "duration": "4n",
      "string": "male",
      "technique": "open",
      "finger": null,
      "bow": "tatakh"
    },
    {
      "time": "0:1:0",
      "pitch": "G3",
      "duration": "4n",
      "string": "male",
      "technique": "cuticle_side_stop",
      "finger": "index",
      "bow": "tülekhe"
    },
    {
      "time": "0:2:0",
      "pitch": "C4",
      "duration": "4n",
      "string": "female",
      "technique": "tsatsal_harmonic",
      "finger": "ring",
      "bow": "tatakh"
    },
    {
      "time": "0:3:0",
      "pitch": "D4",
      "duration": "4n",
      "string": "female",
      "technique": "gulsuulakh_glissando",
      "finger": "pinky",
      "bow": "tülekhe"
    }
  ]
}
```

### 5.3 Automated Visual & Acoustic Verification Test
* **Pitch & Audio Test**: Compares synthesized/sampled frequency against expected cents tolerance (< 5 cents).
* **Fingering Kinematics Test**: Verifies finger index, cuticle side contact coordinate on 3D neck, and string deflection.
* **Bow Direction Alternation**: Verifies proper *Tatakh* (pull) vs *Tülekhe* (push) phrasing rules.

---

## 6. Open-Source Project Structure & Roadmap

```
Morinkhuursimulator/
├── design_references/                 # Generated UI reference mockups
│   ├── morin_khuur_studio_ui.jpg      # Multi-track Studio DAW UI
│   ├── morin_khuur_playground_ui.jpg  # Interactive Playground UI
│   ├── morin_khuur_beatmaker_ui.jpg   # Beat Maker & MPC Pad UI
│   └── morin_khuur_song_tester_ui.jpg # Song Notation & Testing UI
├── packages/
│   ├── audio-core/                    # Tone.js Morin Khuur synthesis & soundbank
│   ├── instrument-3d/                 # Three.js 3D model & kinematic finger/bow rig
│   ├── notation-engine/               # Song notation parser & validator
│   └── beat-maker/                    # Step sequencer & pattern engine
├── public/
│   ├── models/                        # 3D glTF / GLB assets
│   ├── samples/                       # High-res WAV samples (sustain, col legno, etc.)
│   └── songs/                         # Traditional Mongolian song library JSONs
├── MORIN_KHUUR_FOUNDATION_SPEC.md     # This comprehensive foundation spec
└── README.md                          # Open-source mission & getting started
```
