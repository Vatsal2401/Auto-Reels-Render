const isHindiLanguage = (lang: string | undefined): boolean =>
    Boolean(lang && /hindi|hi|हिंदी/i.test(String(lang)));

/** Font that supports Devanagari (Hindi). Use with fontsdir so the bundled font is loaded. */
const FONT_HINDI = 'Noto Sans Devanagari';
const FONT_DEFAULT = 'Arial';

export class AssGenerator {
    static generate(captions: any[], preset: string, position: string, language?: string): string {
        const fontName = isHindiLanguage(language) ? FONT_HINDI : FONT_DEFAULT;

        // ASS Header
        let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;

        // Define Style based on preset using the same mapping logic
        const align = position === 'top' ? 8 : position === 'center' ? 5 : 2;
        const marginV = position === 'top' ? 100 : position === 'center' ? 50 : 150;

        // Colors: &HAlphaBlueGreenRed
        let styleDef = '';
        switch (preset.toLowerCase()) {
            case 'bold-stroke':
                styleDef = `Style: Default,${fontName},32,&H00FFFFFF,&H00FFFF00,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,${align},10,10,${marginV},1`;
                break;
            case 'red-highlight':
                styleDef = `Style: Default,${fontName},32,&H00FFFFFF,&H000000FF,&H000000FF,&H00000000,1,0,0,0,100,100,0,0,1,4,2,${align},10,10,${marginV},1`;
                break;
            case 'karaoke-card':
                // Clean Box background
                styleDef = `Style: Default,${fontName},32,&H00FFFFFF,&H00FF00FF,&H00000000,&H80FF00FF,1,0,0,0,100,100,0,0,3,4,0,${align},10,10,${marginV},1`;
                break;
            case 'beast':
                styleDef = `Style: Default,${fontName},32,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,1,0,0,100,100,0,0,1,5,0,${align},10,10,${marginV},1`;
                break;
            default: // Clean Minimal
                styleDef = `Style: Default,${fontName},32,&H00FFFFFF,&H00FFFF00,&H80000000,&H00000000,1,0,0,0,100,100,0,0,1,2,2,${align},10,10,${marginV},1`;
                break;
        }

        ass += styleDef + '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

        captions.forEach(cap => {
            const start = this.formatTime(cap.start);
            const end = this.formatTime(cap.end);

            let text = '';
            if (cap.words && cap.words.length > 0) {
                // Generate Karaoke Tags: {\k20}Word
                // IMPORTANT: The \k tag duration is relative to the PREVIOUS tag end.
                // The first \k starts at the Dialogue Start Time.

                let cursorTime = cap.start; // Visual start time

                cap.words.forEach((w: any) => {
                    // Calculate wait time relative to cursor
                    // If word starts AFTER cursor (gap), we add a spacer \k or padding?
                    // ASS \k counts duration. \k10 = 0.1s highlight.

                    // Logic: 
                    // 1. Calculate duration from (Previous Word End) to (Current Word End)
                    //    This effectively makes the "active" highlight march forward.
                    //    However, \k highlights the text *inside* the braces? No, {\k10}Text means "Highlight 'Text' for 10cs".

                    // Current Word Duration relative to flow
                    let wordDur = w.end - w.start;

                    // Gap handling: If w.start > cursorTime, we have a silence before this word.
                    // But we can't easily insert "silence" text in Karaoke without breaking string.
                    // Standard Karaoke assumes continuous flow. We will trust the duration.
                    // Better approach: Use w.end - (last_w_end OR cap.start)

                    // Adjust to be relative to the running sequence
                    // Duration of this specific word's bucket
                    let dur = w.end - Math.max(w.start, cursorTime);
                    // If there was a gap, add it to this word's lead-in highlight time?
                    // Actually, \k is display time.

                    // Simpler logic: Duration = (ThisWordEnd - PrevWordEnd).
                    // This ensures the total time aligns with the timeline 100%.

                    // First word: w.end - cap.start.
                    // If cap.start (visual) is 0.8s and word start (audio) is 1.0s,
                    // The first 0.2s is "lead in" waiting.
                    // Then the word plays for 0.5s. Total 0.7s.
                    // If we use w.end - cap.start, the highlight will take 0.7s to fill.
                    // This creates the "highlight BEFORE audio" effect naturally!
                    // It starts filling/highlighting at cap.start (0.8s) and finishes at w.end (1.5s).
                    // PERFECT.

                    let prevEnd = cursorTime;
                    let duration = w.end - prevEnd;
                    if (duration < 0) duration = 0; // Sanity check

                    const cs = Math.round(duration * 100);
                    text += `{\\k${cs}}${w.text} `;

                    cursorTime = w.end;
                });
            } else {
                text = cap.text;
            }

            ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text.trim()}\n`;
        });

        return ass;
    }

    private static formatTime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const cs = Math.floor((seconds % 1) * 100);
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
    }
}
