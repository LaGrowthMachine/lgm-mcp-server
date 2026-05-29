import type { ReactNode } from "react";
import { LGM_COLORS } from "../theme";

// Contenu (JSX) du Modal.confirm de suppression de batch. Réutilisé en
// liste et en page détail. La ligne "N analyses seront supprimées." est
// toujours affichée ; les deux warnings (canon + running) sont
// conditionnels et s'empilent.
//
// Vocabulaire glossaire LGM :
// - "Supprimer" (jamais "Suppr." / "Delete")
// - "Annuler" en bouton de retrait (côté Modal.confirm)
export const renderBatchDeleteContent = (args: {
  n_total: number;
  n_canon: number;
  status: "running" | "done" | "aborted";
}): ReactNode => {
  const { n_total, n_canon, status } = args;
  return (
    <div>
      <p style={{ marginTop: 0 }}>
        {n_total} {n_total === 1 ? "analyse sera" : "analyses seront"} supprimée
        {n_total === 1 ? "" : "s"}.
      </p>
      {n_canon > 0 && (
        <p style={{ color: LGM_COLORS.warning, marginBottom: 8 }}>
          <strong>⚠</strong> {n_canon} analyse{n_canon > 1 ? "s" : ""} serv
          {n_canon > 1 ? "ent" : "t"} de canon pour leur conversation. Ces
          conversations n'auront plus de canon après suppression.
        </p>
      )}
      {status === "running" && (
        <p style={{ color: LGM_COLORS.warning, marginBottom: 0 }}>
          <strong>⚠</strong> Le batch est en cours d'exécution. L'import en
          cours dans cet onglet sera interrompu ; un import lancé depuis un
          autre onglet pourrait voir ses dernières analyses échouer.
        </p>
      )}
    </div>
  );
};
