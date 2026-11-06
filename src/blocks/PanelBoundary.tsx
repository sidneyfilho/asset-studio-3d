// Se o painel de regras tiver um erro, só ele sai do ar (com a mensagem); o editor de mapa continua funcionando.
import { Component, type ReactNode } from "react";

type State = { error: string | null };

export default class PanelBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: String((e as Error)?.message ?? e) };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error">
          O painel Regras teve um erro: {this.state.error}
          <div className="actions"><button onClick={() => this.setState({ error: null })}>Tentar de novo</button></div>
        </div>
      );
    }
    return this.props.children;
  }
}
