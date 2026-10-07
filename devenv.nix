{pkgs, ...}: {
  languages = {
    javascript = {
      enable = true;
      package = pkgs.nodejs-slim_24;
      nodejs.enable = true;
      corepack.enable = true;
      lsp.enable = true;
    };
    typescript = {
      enable = true;
      lsp.enable = true;
    };
  };

  # pi-task-governor's tests drive real jj repositories and direnv environments.
  packages = with pkgs; [
    direnv
    jujutsu
  ];

  enterTest = ''
    node --version
    jj --version
    direnv --version
  '';
}
