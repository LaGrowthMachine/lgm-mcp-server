import type { ThemeConfig } from "antd";

// Source de vérité unique pour la charte visuelle LGM.
// Couleurs extraites de lagrowthmachine.com. Aucune autre couleur hex ne doit
// apparaître ailleurs dans web/ (cf. _bmad-output/ux-harmonization.md).

// Stack monospace partagée — JetBrains Mono chargé via index.html, fallback
// vers la stack système. Importer plutôt que dupliquer la string inline.
export const MONO_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const LGM_COLORS = {
  // Vert primaire LGM (CTA, item actif, success)
  green: "#3CC878",
  greenHover: "#2db368",
  greenActive: "#26a05c",
  greenTint: "rgba(61,199,120,.08)",
  greenTintStrong: "rgba(61,199,120,.16)",

  // Purple-charcoal (chrome de marque : header, sidebar, texte principal)
  charcoal: "#231932",
  charcoalDeep: "#1a1030",
  charcoalSoft: "rgba(35,25,50,.6)",

  // Corail — réservé aux actions destructives et erreurs (signature LGM)
  coral: "#ff6359",
  coralHover: "#e84d44",
  coralTint: "rgba(255,99,89,.08)",

  // Surfaces
  surface: "#ffffff",
  surfaceMuted: "#f7f6f4",
  surfaceSubtle: "#fafaf8",

  // Bordures
  border: "#e8e6e1",
  borderSubtle: "#f0eeea",

  // Texte
  textBase: "#231932",
  textSecondary: "#6b6577",
  textTertiary: "#9a94a3",

  // Sémantiques (non-LGM, conservées pour les statuts neutres)
  warning: "#f59e0b",
  info: "#5a8cff",
} as const;

export const lgmTheme: ThemeConfig = {
  cssVar: true,
  hashed: true,
  token: {
    colorPrimary: LGM_COLORS.green,
    colorSuccess: LGM_COLORS.green,
    colorError: LGM_COLORS.coral,
    colorWarning: LGM_COLORS.warning,
    colorInfo: LGM_COLORS.info,
    colorTextBase: LGM_COLORS.textBase,
    colorBgBase: LGM_COLORS.surface,
    colorBgLayout: LGM_COLORS.surfaceMuted,
    colorBorder: LGM_COLORS.border,
    colorBorderSecondary: LGM_COLORS.borderSubtle,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontFamily:
      'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: 14,
    fontSizeHeading3: 22,
    fontSizeHeading4: 17,
    fontSizeHeading5: 15,
    wireframe: false,
    boxShadowTertiary: "0 1px 2px rgba(35,25,50,.04)",
  },
  components: {
    Layout: {
      headerBg: LGM_COLORS.charcoal,
      headerColor: "#ffffff",
      headerHeight: 56,
      headerPadding: "0 24px",
      siderBg: LGM_COLORS.charcoal,
      bodyBg: LGM_COLORS.surfaceMuted,
    },
    Menu: {
      darkItemBg: LGM_COLORS.charcoal,
      darkSubMenuItemBg: LGM_COLORS.charcoalDeep,
      darkItemSelectedBg: LGM_COLORS.greenTintStrong,
      darkItemSelectedColor: LGM_COLORS.green,
      darkItemHoverBg: "rgba(255,255,255,.06)",
      darkItemHoverColor: "#ffffff",
      darkItemColor: "rgba(255,255,255,.78)",
      itemHeight: 40,
      itemMarginInline: 8,
      iconSize: 16,
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      fontWeight: 500,
    },
    Card: {
      headerBg: "transparent",
      headerFontSize: 14,
      headerFontSizeSM: 13,
      paddingLG: 20,
    },
    Table: {
      headerBg: LGM_COLORS.surfaceSubtle,
      headerColor: LGM_COLORS.textSecondary,
      headerSplitColor: LGM_COLORS.borderSubtle,
      rowHoverBg: LGM_COLORS.greenTint,
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      borderColor: LGM_COLORS.borderSubtle,
    },
    Tag: {
      defaultBg: "#f4f2ee",
      defaultColor: LGM_COLORS.textSecondary,
    },
    Typography: {
      titleMarginTop: 0,
      titleMarginBottom: 0,
    },
    Input: {
      activeShadow: "0 0 0 2px rgba(61,199,120,.15)",
    },
    Select: {
      optionSelectedBg: LGM_COLORS.greenTint,
    },
    Segmented: {
      itemSelectedBg: "#ffffff",
      itemSelectedColor: LGM_COLORS.charcoal,
      trackBg: LGM_COLORS.surfaceSubtle,
    },
    Progress: {
      defaultColor: LGM_COLORS.green,
    },
    Statistic: {
      titleFontSize: 13,
      contentFontSize: 22,
    },
  },
};
