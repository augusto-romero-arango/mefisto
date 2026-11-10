# Validador versionado del mapping abierto runtime -> {profiles, agents, efforts}.
def issue($path; $reason): "\($path): \($reason)";
def effort_levels: ["quick","light","standard","thorough","exhaustive"];
def model_errors($path):
  if type != "string" then [issue($path; "se esperaba un string no vacio")]
  elif length == 0 then [issue($path; "se esperaba un string no vacio")]
  else [] end;
if type != "object" then
  [issue("."; "se esperaba un objeto")]
else
  [to_entries[]
   | .key as $runtime | .value as $config
   | if ($runtime | test("^[a-z0-9_]+$") | not) then
       issue($runtime; "id de runtime invalido")
     elif ($config | type) != "object" then
       issue($runtime; "se esperaba un objeto")
     else
       ([ $config | keys_unsorted[] | select(. != "profiles" and . != "agents" and . != "efforts")
          | issue("\($runtime).\(.)"; "campo desconocido") ]
        + (if ($config | has("profiles") | not) then []
           elif ($config.profiles | type) != "object" then [issue("\($runtime).profiles"; "se esperaba un objeto")]
           else [ $config.profiles | to_entries[]
                  | .key as $profile | .value
                  | if ($profile != "fast" and $profile != "balanced" and $profile != "deep")
                    then issue("\($runtime).profiles.\($profile)"; "perfil desconocido")
                    else model_errors("\($runtime).profiles.\($profile)")[] end ]
           end)
        + (if ($config | has("agents") | not) then []
           elif ($config.agents | type) != "object" then [issue("\($runtime).agents"; "se esperaba un objeto")]
           else [ $config.agents | to_entries[] | .key as $agent | .value
                  | model_errors("\($runtime).agents.\($agent)")[] ]
           end)
        + (if ($config | has("efforts") | not) then []
           elif ($config.efforts | type) != "object" then [issue("\($runtime).efforts"; "se esperaba un objeto")]
           else
             ([ $config.efforts | keys_unsorted[] | select(. != "agents" and . != "levels")
                | issue("\($runtime).efforts.\(.)"; "campo desconocido") ]
              + (if ($config.efforts | has("agents") | not) then []
                 elif ($config.efforts.agents | type) != "object" then [issue("\($runtime).efforts.agents"; "se esperaba un objeto")]
                 else [ $config.efforts.agents | to_entries[] | .key as $agent | .value as $v
                        | if ($v | type) == "string" and (effort_levels | index($v)) != null then empty
                          else issue("\($runtime).efforts.agents.\($agent)"; "nivel desconocido") end ]
                 end)
              + (if ($config.efforts | has("levels") | not) then []
                 elif ($config.efforts.levels | type) != "object" then [issue("\($runtime).efforts.levels"; "se esperaba un objeto")]
                 else [ $config.efforts.levels | to_entries[] | .key as $lvl
                        | if (effort_levels | index($lvl)) == null
                          then issue("\($runtime).efforts.levels.\($lvl)"; "nivel desconocido")
                          else (.value | model_errors("\($runtime).efforts.levels.\($lvl)"))[] end ]
                 end))
           end))[]
     end]
end | .[]
