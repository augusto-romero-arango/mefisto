import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { coverageClassifyFile } from '../lib/pipeline/coverage.mts'
import type { CoverageClass } from '../lib/pipeline/coverage.mts'
import { writeIn } from './consumer-sandbox.mts'
import { NO_BASH_TWIN, bashTwin } from './pipeline-metrics-parity.mts'

interface Case {
  name: string
  path: string
  /** `null`: el archivo no existe en el worktree. */
  content: string | null
  projection?: boolean
  expected: CoverageClass
  /** En bash el resultado depende del locale: fuera de la paridad. */
  localeDependent?: boolean
}

const cs = (namespace: string, ...body: string[]): string => [`namespace ${namespace};`, ...body, ''].join('\n')

const CASES: Case[] = [
  // Exclusion por nombre de archivo.
  { name: 'HealthCheck.cs', path: 'src/Foo.Bar/HealthCheck.cs', content: cs('Foo.Bar', 'public sealed class HealthCheck { }'), expected: 'excluded' },
  { name: 'Program.cs', path: 'src/Foo.Bar/Program.cs', content: 'var host = new HostBuilder().Build();\nhost.Run();\n', expected: 'excluded' },
  { name: '*Mensajes.cs', path: 'src/Foo.Bar/TurnoMensajes.cs', content: cs('Foo.Bar', 'internal static class TurnoMensajes { }'), expected: 'excluded' },
  { name: '*AssemblyMarker.cs', path: 'src/Foo.Bar/FooAssemblyMarker.cs', content: cs('Foo.Bar', 'public sealed class FooAssemblyMarker { }'), expected: 'excluded' },
  {
    name: 'ConfiguracionSerializacion*.cs',
    path: 'src/Foo.Bar/ConfiguracionSerializacionEventos.cs',
    content: cs('Foo.Bar', 'public static class ConfiguracionSerializacionEventos { }'),
    expected: 'excluded',
  },
  { name: '*.resx', path: 'src/Foo.Bar/Mensajes.resx', content: '', expected: 'excluded' },
  {
    name: 'IdentidadEventos*.cs',
    path: 'src/Foo.Bar.Ventas.DomainEvents/IdentidadEventosVentas.cs',
    content: cs('Foo.Bar.Ventas.DomainEvents', 'public static class IdentidadEventosVentas { }'),
    expected: 'excluded',
  },
  // Wiring de Infraestructura/.
  {
    name: 'Infraestructura/{subcarpeta}/RequestValidator.cs',
    path: 'src/Foo.Bar/Infraestructura/Validacion/RequestValidator.cs',
    content: cs('Foo.Bar.Infraestructura.Validacion', 'internal sealed class RequestValidator { }'),
    expected: 'excluded',
  },
  {
    name: 'Infraestructura/{subcarpeta}/ServiceBusDeserializador.cs',
    path: 'src/Foo.Bar/Infraestructura/Validacion/ServiceBusDeserializador.cs',
    content: cs('Foo.Bar.Infraestructura.Validacion', 'internal sealed class ServiceBusDeserializador { }'),
    expected: 'excluded',
  },
  {
    name: 'RequestValidator.cs directo en Infraestructura/ sigue siendo logica',
    path: 'src/Foo.Bar/Infraestructura/RequestValidator.cs',
    content: cs('Foo.Bar.Infraestructura', 'internal sealed class RequestValidator { }'),
    expected: 'logic',
  },
  {
    name: 'RequestValidator.cs fuera de Infraestructura/',
    path: 'src/Foo.Bar/RequestValidator.cs',
    content: cs('Foo.Bar', 'internal sealed class RequestValidator { }'),
    expected: 'logic',
  },
  // Carve-out read-side del FunctionEndpoint.cs de una query GET.
  { name: 'Obtener{X} bajo tipo:projection', path: 'src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs', content: cs('Foo.Bar.ObtenerTurno', 'public sealed class FunctionEndpoint { }'), projection: true, expected: 'excluded' },
  { name: 'Obtener{X} fuera de tipo:projection', path: 'src/Foo.Bar/ObtenerTurno/FunctionEndpoint.cs', content: cs('Foo.Bar.ObtenerTurno', 'public sealed class FunctionEndpoint { }'), expected: 'logic' },
  { name: 'Listar{X}s bajo tipo:projection', path: 'src/Foo.Bar/ListarTurnos/FunctionEndpoint.cs', content: cs('Foo.Bar.ListarTurnos', 'public sealed class FunctionEndpoint { }'), projection: true, expected: 'excluded' },
  { name: 'carpeta con sufijo Function es un comando', path: 'src/Foo.Bar/CrearTurnoFunction/FunctionEndpoint.cs', content: cs('Foo.Bar.CrearTurnoFunction', 'public sealed class FunctionEndpoint { }'), projection: true, expected: 'logic' },
  { name: 'Obtener{X}Function es un comando', path: 'src/Foo.Bar/ObtenerCodigoFunction/FunctionEndpoint.cs', content: null, projection: true, expected: 'logic' },
  { name: 'ListarEventosDe{Aggregate}', path: 'src/Foo.Bar/ListarEventosDeTurno/FunctionEndpoint.cs', content: null, projection: true, expected: 'excluded' },
  { name: 'CommandHandler bajo tipo:projection', path: 'src/Foo.Bar/CrearTurnoFunction/CommandHandler/CrearTurnoCommandHandler.cs', content: null, projection: true, expected: 'logic' },
  // Logica por nombre de archivo.
  { name: '*CommandHandler.cs', path: 'src/Foo.Bar/CrearTurnoCommandHandler.cs', content: cs('Foo.Bar', 'public sealed class CrearTurnoCommandHandler { }'), expected: 'logic' },
  { name: '*AggregateRoot.cs', path: 'src/Foo.Bar/TurnoAggregateRoot.cs', content: cs('Foo.Bar', 'public sealed class TurnoAggregateRoot { }'), expected: 'logic' },
  { name: '*Validator.cs', path: 'src/Foo.Bar/CrearTurnoValidator.cs', content: cs('Foo.Bar', 'public sealed class CrearTurnoValidator { }'), expected: 'logic' },
  {
    name: '*Projection.cs con tipo:projection',
    path: 'src/Foo.Bar/TurnoProjection.cs',
    content: cs('Foo.Bar', 'public sealed partial class TurnoProjection : SingleStreamProjection<TurnoView, Guid>', '{', '    public static TurnoView Create(TurnoCreado e) => new(e.Id, "Abierto");', '}'),
    projection: true,
    expected: 'logic',
  },
  { name: '*Projection.cs sin tipo:projection', path: 'src/Foo.Bar/TurnoProjection.cs', content: cs('Foo.Bar', 'public sealed partial class TurnoProjection { }'), expected: 'logic' },
  { name: 'ConfiguracionMartenProjections.cs (plural)', path: 'src/Foo.Bar/ConfiguracionMartenProjections.cs', content: cs('Foo.Bar', 'public static class ConfiguracionMartenProjections { }'), expected: 'not_evaluated' },
  { name: 'ConfiguracionMartenProjections{Dominio}.cs', path: 'src/Foo.Bar/ConfiguracionMartenProjectionsVentas.cs', content: cs('Foo.Bar', 'public static class ConfiguracionMartenProjectionsVentas { }'), expected: 'not_evaluated' },
  {
    name: '*EventHandler.cs',
    path: 'src/Foo.Bar/TurnoCreadoEventHandler.cs',
    content: cs('Foo.Bar', 'public partial class TurnoCreadoEventHandler(IEventStore eventStore)', '    : IPrivateEventHandlerAsync<TurnoCreado>', '{', '}'),
    expected: 'logic',
  },
  {
    name: '{EventHandler}.Mensajes.cs sigue excluido',
    path: 'src/Foo.Bar/TurnoCreadoEventHandler.Mensajes.cs',
    content: cs('Foo.Bar', 'public partial class TurnoCreadoEventHandler', '{', '    public static class Mensajes { }', '}'),
    expected: 'excluded',
  },
  { name: '*Tool.cs', path: 'src/Foo.Mcp.Colaboradores/ListarColaboradoresTool.cs', content: cs('Foo.Mcp.Colaboradores', 'public sealed class ListarColaboradoresTool { }'), expected: 'logic' },
  // Factory Crear() en eventos, entidades y value objects.
  {
    name: 'evento con Crear()',
    path: 'src/Foo.Bar/Feature/Eventos/V1/TurnoCreado.cs',
    content: cs('Foo.Bar.Feature.Eventos', 'public sealed record TurnoCreado(Guid Id)', '{', '    public static TurnoCreado Crear(Guid id) => new(id);', '}'),
    expected: 'logic',
  },
  {
    name: 'entidad con Crear()',
    path: 'src/Foo.Bar/Feature/Entities/V1/Codigo.cs',
    content: cs('Foo.Bar.Feature.Entities', 'public sealed record Codigo(string Valor)', '{', '    public static Codigo Crear(string valor) => new(valor);', '}'),
    expected: 'logic',
  },
  {
    name: 'value object con Crear()',
    path: 'src/Foo.Bar/Contracts/ValueObjects/V1/Codigo.cs',
    content: cs('Foo.Bar.Contracts.ValueObjects', 'public sealed record Codigo(string Valor)', '{', '    public static Codigo Crear(string valor) => new(valor);', '}'),
    expected: 'logic',
  },
  {
    name: 'evento con Crear() en la raiz de *.DomainEvents/',
    path: 'src/Foo.Bar.Ventas.DomainEvents/VentaCreada.cs',
    content: cs('Foo.Bar.Ventas.DomainEvents', 'public sealed record VentaCreada(Guid Id)', '{', '    public static VentaCreada Crear(Guid id) => new(id);', '}'),
    expected: 'logic',
  },
  {
    name: 'evento con Crear() en una subcarpeta de *.DomainEvents/',
    path: 'src/Foo.Bar.Ventas.DomainEvents/V2/VentaCreada.cs',
    content: cs('Foo.Bar.Ventas.DomainEvents.V2', 'public sealed record VentaCreada(Guid Id, string Motivo)', '{', '    public static VentaCreada Crear(Guid id, string motivo) => new(id, motivo);', '}'),
    expected: 'logic',
  },
  {
    name: 'evento sin Crear() en *.DomainEvents/',
    path: 'src/Foo.Bar.Ventas.DomainEvents/VentaCancelada.cs',
    content: cs('Foo.Bar.Ventas.DomainEvents', 'public sealed record VentaCancelada(Guid Id)', '{', '    public bool EsValida() => Id != Guid.Empty;', '}'),
    expected: 'not_evaluated',
  },
  {
    name: 'Crear() fuera de las carpetas con factory',
    path: 'src/Foo.Bar/Otros/Codigo.cs',
    content: cs('Foo.Bar.Otros', 'public sealed record Codigo(string Valor)', '{', '    public static Codigo Crear(string valor) => new(valor);', '}'),
    expected: 'not_evaluated',
  },
  // Records DTO.
  { name: 'public sealed record multilinea', path: 'src/Foo.ReadModels/TurnoView.cs', content: cs('Foo.ReadModels', 'public sealed record TurnoView(', '    Guid Id, string Estado, DateOnly FechaInicio);'), expected: 'excluded' },
  { name: 'public record de una linea', path: 'src/Foo.ReadModels/PlanoView.cs', content: cs('Foo.ReadModels', 'public record PlanoView(Guid Id, string Nombre);'), expected: 'excluded' },
  {
    name: 'record con metodos',
    path: 'src/Foo.ReadModels/ResumenView.cs',
    content: cs('Foo.ReadModels', 'public sealed record ResumenView(Guid Id, string Estado)', '{', '    public bool EsActivo() => Estado == "Abierto";', '}'),
    expected: 'not_evaluated',
  },
  { name: 'modificadores sealed y partial', path: 'src/Foo.ReadModels/OtraView.cs', content: cs('Foo.ReadModels', 'public sealed partial record OtraView(Guid Id);'), expected: 'excluded' },
  {
    name: 'DTO junto a una clase con metodos',
    path: 'src/Foo.Bar/AyudanteConDto.cs',
    content: cs('Foo.Bar', 'public sealed record DatosAuxiliares(Guid Id);', 'public static class AyudanteConDto', '{', '    public static bool EsValido(DatosAuxiliares d) => d.Id != Guid.Empty;', '}'),
    expected: 'not_evaluated',
  },
  {
    name: 'record anidado en una clase con metodos',
    path: 'src/Foo.Bar/ClaseConRecordAnidado.cs',
    content: cs('Foo.Bar', 'public sealed class ClaseConRecordAnidado', '{', '    public sealed record Anidado(Guid Id);', '    public bool EsValido(Anidado a) => a.Id != Guid.Empty;', '}'),
    expected: 'not_evaluated',
  },
  { name: 'dos records puros', path: 'src/Foo.ReadModels/DosViews.cs', content: cs('Foo.ReadModels', 'public sealed record UnaView(Guid Id);', 'public sealed record OtraMasView(Guid Id);'), expected: 'excluded' },
  {
    name: 'read model con coleccion, enum y nullable',
    path: 'src/Foo.ReadModels/DetalleView.cs',
    content: [
      'using System;',
      'using System.Collections.Generic;',
      'namespace Foo.ReadModels;',
      '/// Read model canonico con coleccion, enum y nullable.',
      'public sealed record DetalleView(',
      '    Guid Id,',
      '    EstadoTurno Estado,',
      '    IReadOnlyList<string> Etiquetas,',
      '    DateOnly? FechaCierre);',
      '',
    ].join('\n'),
    expected: 'excluded',
  },
  { name: 'record de bus con marker en PublicEvents/', path: 'src/Foo.Bar.PublicEvents/Ventas/VentaPublicada.cs', content: cs('Foo.Bar.PublicEvents.Ventas', 'public sealed record VentaPublicada(Guid Id) : IPublicEvent;'), expected: 'excluded' },
  {
    name: 'contrato upstream con varios records puros',
    path: 'src/Foo.Mcp.Colaboradores/Infraestructura/FichaColaborador.cs',
    content: cs('Foo.Mcp.Colaboradores.Infraestructura', 'public sealed record FichaColaborador(', '    Guid Id,', '    string Nombre,', '    EtiquetaFicha Etiqueta);', 'public sealed record EtiquetaFicha(', '    string Codigo,', '    string Descripcion);'),
    expected: 'excluded',
  },
  {
    name: 'record puro junto a una clase con metodos, en Infraestructura/',
    path: 'src/Foo.Mcp.Colaboradores/Infraestructura/FichaConFiltro.cs',
    content: cs('Foo.Mcp.Colaboradores.Infraestructura', 'public sealed record FichaConFiltro(Guid Id, string Nombre);', 'public static class FiltroDeFicha', '{', '    public static bool EsValida(FichaConFiltro f) => f.Id != Guid.Empty;', '}'),
    expected: 'not_evaluated',
  },
  { name: 'record con CRLF y sin salto final', path: 'src/Foo.ReadModels/CrlfView.cs', content: 'namespace Foo.ReadModels;\r\n\r\n  // comentario\r\npublic sealed record CrlfView(int Valor);', expected: 'excluded' },
  { name: 'record con identificador acentuado', path: 'src/Foo.ReadModels/AnioView.cs', content: cs('Foo.ReadModels', 'public sealed record AñoView(int Año);'), expected: 'excluded', localeDependent: true },
  { name: 'record con parametro con valor por defecto entre parentesis', path: 'src/Foo.ReadModels/DefectoView.cs', content: cs('Foo.ReadModels', 'public sealed record DefectoView(Guid Id = default(Guid));'), expected: 'not_evaluated' },
  // Cliente HTTP tipado de un servidor MCP.
  { name: 'Infraestructura/{X}Api.cs sin subcarpeta', path: 'src/Foo.Mcp.Colaboradores/Infraestructura/ColaboradoresApi.cs', content: cs('Foo.Mcp.Colaboradores.Infraestructura', 'internal sealed class ColaboradoresApi { }'), expected: 'excluded' },
  { name: 'Infraestructura/{subcarpeta}/{X}Api.cs', path: 'src/Foo.Mcp.Colaboradores/Infraestructura/Clientes/NominaApi.cs', content: cs('Foo.Mcp.Colaboradores.Infraestructura.Clientes', 'internal sealed class NominaApi { }'), expected: 'excluded' },
  { name: '*Api.cs fuera de Infraestructura/', path: 'src/Foo.Mcp.Colaboradores/ColaboradoresApi.cs', content: cs('Foo.Mcp.Colaboradores', 'internal sealed class ColaboradoresApi { }'), expected: 'not_evaluated' },
  { name: 'Infraestructura como carpeta raiz', path: 'Infraestructura/RaizApi.cs', content: null, expected: 'excluded' },
  { name: '*Api.cs en una carpeta que solo empieza por Infraestructura', path: 'src/InfraestructuraVieja/OtroApi.cs', content: null, expected: 'not_evaluated' },
  // Nada coincide.
  { name: 'clase auxiliar', path: 'src/Foo.Bar/Ayudante.cs', content: cs('Foo.Bar', 'public static class Ayudante', '{', '    public static bool EsValido(Guid id) => id != Guid.Empty;', '}'), expected: 'not_evaluated' },
  { name: 'archivo inexistente', path: 'src/Foo.Bar/NoExiste.cs', content: null, expected: 'not_evaluated' },
  { name: 'archivo vacio', path: 'src/Foo.Bar/Vacio.cs', content: '', expected: 'not_evaluated' },
  { name: 'archivo en la raiz', path: 'Suelto.cs', content: 'public record Suelto(int A);\n', expected: 'excluded' },
]

let root = ''

/** Worktree con el archivo del caso como unico contenido. */
function worktreeFor(index: number, item: Case): string {
  const worktree = join(root, `caso-${index}`)
  mkdirSync(worktree, { recursive: true })
  if (item.content !== null) writeIn(worktree, item.path, item.content)
  return worktree
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mefisto coverage '))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('coverageClassifyFile', () => {
  for (const [index, item] of CASES.entries()) {
    test(`${item.name} -> ${item.expected}`, () => {
      assert.equal(coverageClassifyFile(item.path, worktreeFor(index, item), item.projection ?? false), item.expected)
    })
  }

  test('sin isProjection el carve-out read-side no aplica', () => {
    assert.equal(coverageClassifyFile('src/Foo.Bar/ListarTurnos/FunctionEndpoint.cs', root), 'logic')
  })
})

describe('paridad con la gemela bash', { skip: NO_BASH_TWIN }, () => {
  for (const [index, item] of CASES.entries()) {
    if (item.localeDependent === true) continue
    test(`coverage_classify_file: ${item.name}`, () => {
      const worktree = worktreeFor(index, item)
      for (const projection of [true, false]) {
        const bash = bashTwin('coverage_classify_file "$@"', [item.path, worktree, String(projection)])
        assert.equal(bash.status, 0)
        assert.equal(`${coverageClassifyFile(item.path, worktree, projection)}\n`, bash.stdout)
      }
    })
  }
})
