// Sem janela de console no Windows na versão final
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    asset_studio_lib::run()
}
