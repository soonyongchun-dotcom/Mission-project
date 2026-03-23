import argparse
import csv
import math
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple, Dict, Any

import matplotlib.pyplot as plt
import numpy as np


@dataclass
class Shot:
    carry: float
    side_total: float
    height: float
    back_spin: float
    side_spin: float


def load_shots_from_csv(path: str) -> List[Shot]:
    shots = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if all(row.get(k, '').strip() == '' for k in ['Carry', 'SideTotal', 'Height', 'BackSpin', 'SideSpin']):
                continue
            shots.append(Shot(
                carry=float(row['Carry']),
                side_total=float(row['SideTotal']),
                height=float(row['Height']),
                back_spin=float(row['BackSpin']),
                side_spin=float(row['SideSpin']),
            ))
    return shots


def minimal_enclosing_circle(points: List[Tuple[float, float]]) -> Tuple[Tuple[float, float], float]:
    # Welzl's algorithm simple deterministic O(n^4) fallback due to small n=10
    if not points:
        return ((0.0, 0.0), 0.0)

    def circle_from_2(a, b):
        cx = (a[0] + b[0]) / 2.0
        cy = (a[1] + b[1]) / 2.0
        r = math.hypot(a[0] - cx, a[1] - cy)
        return (cx, cy), r

    def circle_from_3(a, b, c):
        d = 2 * (a[0]*(b[1]-c[1]) + b[0]*(c[1]-a[1]) + c[0]*(a[1]-b[1]))
        if abs(d) < 1e-9:
            return None
        ux = ((a[0]**2 + a[1]**2)*(b[1]-c[1]) + (b[0]**2 + b[1]**2)*(c[1]-a[1]) + (c[0]**2 + c[1]**2)*(a[1]-b[1])) / d
        uy = ((a[0]**2 + a[1]**2)*(c[0]-b[0]) + (b[0]**2 + b[1]**2)*(a[0]-c[0]) + (c[0]**2 + c[1]**2)*(b[0]-a[0])) / d
        center = (ux, uy)
        r = math.hypot(center[0]-a[0], center[1]-a[1])
        return center, r

    mec_center, mec_r = points[0], 0.0
    for i in range(len(points)):
        if math.hypot(points[i][0]-mec_center[0], points[i][1]-mec_center[1]) > mec_r + 1e-9:
            mec_center, mec_r = points[i], 0.0
            for j in range(i):
                if math.hypot(points[j][0]-mec_center[0], points[j][1]-mec_center[1]) > mec_r + 1e-9:
                    mec_center, mec_r = circle_from_2(points[i], points[j])
                    for k in range(j):
                        if math.hypot(points[k][0]-mec_center[0], points[k][1]-mec_center[1]) > mec_r + 1e-9:
                            c = circle_from_3(points[i], points[j], points[k])
                            if c is not None:
                                mec_center, mec_r = c
    return mec_center, mec_r


def summarize_metrics(shots: List[Shot]) -> Dict[str, Any]:
    if len(shots) != 10:
        raise ValueError('정확히 10개의 샷 데이터를 입력해야 합니다.')

    carries = np.array([s.carry for s in shots])
    sides = np.array([s.side_total for s in shots])
    heights = np.array([s.height for s in shots])
    back_spins = np.array([s.back_spin for s in shots])
    side_spins = np.array([s.side_spin for s in shots])

    pointcloud = list(zip(sides, carries))  # x: SideTotal, y: Carry
    (cx, cy), radius = minimal_enclosing_circle(pointcloud)
    diameter = radius * 2.0
    area = math.pi * (radius ** 2)

    carry_mean = carries.mean()
    height_mean = heights.mean()
    spin_mean = back_spins.mean()

    details = {
        'count': len(shots),
        'carry': {
            'mean': float(carry_mean),
            'std': float(carries.std(ddof=1)),
            'range': float(carries.max() - carries.min()),
            'min': float(carries.min()),
            'max': float(carries.max()),
        },
        'height': {
            'mean': float(height_mean),
            'std': float(heights.std(ddof=1)),
            'range': float(heights.max() - heights.min()),
        },
        'side_total': {
            'mean': float(sides.mean()),
            'std': float(sides.std(ddof=1)),
            'range': float(sides.max() - sides.min()),
        },
        'back_spin': {
            'mean': float(spin_mean),
            'std': float(back_spins.std(ddof=1)),
            'range': float(back_spins.max() - back_spins.min()),
        },
        'side_spin': {
            'mean': float(side_spins.mean()),
            'std': float(side_spins.std(ddof=1)),
            'range': float(side_spins.max() - side_spins.min()),
        },
        'scatter': {
            'circle': {
                'center_x': float(cx),
                'center_y': float(cy),
                'radius': float(radius),
                'diameter': float(diameter),
                'area': float(area),
            }
        },
    }

    return details


def evaluate_pass_fail(club: str, summary: Dict[str, Any]) -> Dict[str, Any]:
    diameter = summary['scatter']['circle']['diameter']
    disp_limit = 12.0 if club in ['7I', '7번', '7번 아이언'] else 8.0

    pass_A = diameter <= disp_limit

    carry_range = summary['carry']['range']
    height_range = summary['height']['range']
    side_total_range = summary['side_total']['range']
    side_spin_range = summary['side_spin']['range']

    tightness_advice = []
    if carry_range > 6.0:
        tightness_advice.append('캐리 거리 편차가 큽니다. 임팩트 시 헤드스피드·타이밍 일관성을 향상시킵니다.')
    elif carry_range > 4.0:
        tightness_advice.append('캐리 거리 편차가 보통입니다. 거리 안정성을 추가 점검하세요.')
    else:
        tightness_advice.append('캐리 거리 분포가 매우 안정적입니다.')

    if height_range > 3.5:
        tightness_advice.append('로프트/탄도 제어에 불안정성이 있습니다. 어택 앵글을 점검하세요.')
    elif height_range > 2.0:
        tightness_advice.append('탄도 편차가 중간 수준입니다. 스윙 궤적과 클럽 페이스 앵글 일관성을 확인하세요.')
    else:
        tightness_advice.append('높이 편차가 아주 좁습니다. 탄도 컨트롤이 좋습니다.')

    if abs(summary['side_total']['mean']) > 1.5:
        tightness_advice.append('좌우 편차 평균이 크게 치우침. 페이스 앵글과 경로 일관성을 확인하세요.')

    if side_spin_range > 350:
        tightness_advice.append('사이드스핀 편차가 큽니다. 스윙 궤도 및 릴리스 타이밍을 점검하세요.')

    final_pass = pass_A and carry_range <= 8.0 and height_range <= 3.5 and abs(summary['side_total']['mean']) <= 2.0

    return {
        'criterion_A': {
            'diameter_m': diameter,
            'limit_m': disp_limit,
            'pass': pass_A,
        },
        'criterion_B': {
            'carry_range_m': carry_range,
            'height_range_m': height_range,
            'side_total_range_m': side_total_range,
            'side_spin_range_rpm': side_spin_range,
            'advice': tightness_advice,
        },
        'final_pass': final_pass,
    }


def generate_report(club: str, shots: List[Shot], summary: Dict[str, Any], evaluation: Dict[str, Any], output_prefix: str):
    report_lines = []
    report_lines.append(f"클럽: {club}")
    report_lines.append(f"샷 수: {len(shots)}")

    circle = summary['scatter']['circle']
    report_lines.append(f"분포 원 직경: {circle['diameter']:.2f} m / 한계: {evaluation['criterion_A']['limit_m']:.2f} m")
    report_lines.append(f"분포 영역: {circle['area']:.2f} m^2")
    report_lines.append(f"기준A 통과: {evaluation['criterion_A']['pass']}")

    report_lines.append("\n핵심 지표 편차")
    report_lines.append(f"- Carry: {summary['carry']['mean']:.1f} ± {summary['carry']['range'] / 2:.1f} m (range {summary['carry']['range']:.2f} m)")
    report_lines.append(f"- Height: {summary['height']['mean']:.1f} ± {summary['height']['range'] / 2:.1f} m (range {summary['height']['range']:.2f} m)")
    report_lines.append(f"- Side Total: {summary['side_total']['mean']:.1f} ± {summary['side_total']['range'] / 2:.1f} m (range {summary['side_total']['range']:.2f} m)")
    report_lines.append(f"- Back Spin: {summary['back_spin']['mean']:.0f} ± {summary['back_spin']['range'] / 2:.0f} rpm (range {summary['back_spin']['range']:.0f} rpm)")
    report_lines.append(f"- Side Spin: {summary['side_spin']['mean']:.0f} ± {summary['side_spin']['range'] / 2:.0f} rpm (range {summary['side_spin']['range']:.0f} rpm)")

    report_lines.append("\n코칭 코멘트")
    for text in evaluation['criterion_B']['advice']:
        report_lines.append('- ' + text)

    report_lines.append(f"\n최종 판정: {'Pass' if evaluation['final_pass'] else 'Fail'}")

    report_path = Path(output_prefix + '_report.txt')
    report_path.write_text('\n'.join(report_lines), encoding='utf-8')

    return report_path


def make_plots(shots: List[Shot], summary: Dict[str, Any], output_prefix: str):
    carries = [s.carry for s in shots]
    sides = [s.side_total for s in shots]
    heights = [s.height for s in shots]
    side_spins = [s.side_spin for s in shots]

    plt.figure(figsize=(12, 8))

    plt.subplot(2, 2, 1)
    plt.scatter(carries, heights, c='blue', s=80)
    plt.xlabel('Carry (m)')
    plt.ylabel('Height (m)')
    plt.title('Carry vs Height')
    plt.grid(True)

    plt.subplot(2, 2, 2)
    plt.scatter(sides, side_spins, c='green', s=80)
    plt.xlabel('Side Total (m)')
    plt.ylabel('Side Spin (rpm)')
    plt.title('Side Total vs Side Spin')
    plt.grid(True)

    plt.subplot(2, 1, 2)
    plt.scatter(sides, carries, c='red', s=80)
    circle = summary['scatter']['circle']
    theta = np.linspace(0, 2 * np.pi, 200)
    circ_x = circle['center_x'] + circle['radius'] * np.cos(theta)
    circ_y = circle['center_y'] + circle['radius'] * np.sin(theta)
    plt.plot(circ_x, circ_y, color='orange', linewidth=2, label='Min Enclosing Circle')
    plt.scatter(circle['center_x'], circle['center_y'], c='black', s=40, label='Center')
    plt.xlabel('Side Total (m)')
    plt.ylabel('Carry (m)')
    plt.title('Side Total vs Carry (Dispersion Circle)')
    plt.legend()
    plt.grid(True)

    plt.tight_layout(pad=2.0)
    output_file = Path(output_prefix + '_scatter.png')
    plt.savefig(output_file, dpi=150)
    plt.close()
    return output_file


def main():
    parser = argparse.ArgumentParser(description='Scatter Plot 기반 아이언 일관성 마스터 미션 분석기')
    parser.add_argument('--club', required=True, help='클럽 (예: 7I, 9I, PW)')
    parser.add_argument('--csv', required=False, help='샷 데이터를 담은 CSV 파일 경로')
    parser.add_argument('--output-prefix', default='output', help='파일명 접두사')
    parser.add_argument('--dry-run', action='store_true', help='데모 샷으로 실행합니다')
    args = parser.parse_args()

    if args.dry_run:
        shots = [
            Shot(140.3, 0.8, 21.3, 6100, 180),
            Shot(139.8, -1.1, 20.7, 6050, 140),
            Shot(138.4, 0.3, 20.1, 6200, 200),
            Shot(141.7, -0.5, 21.0, 6150, 150),
            Shot(139.9, 0.7, 20.8, 6080, 170),
            Shot(140.9, -0.3, 21.5, 6120, 160),
            Shot(138.6, 0.4, 20.3, 6180, 190),
            Shot(140.1, 0.0, 20.9, 6105, 175),
            Shot(139.2, -0.7, 20.6, 6090, 160),
            Shot(140.5, 0.2, 20.4, 6145, 165),
        ]
    elif args.csv:
        shots = load_shots_from_csv(args.csv)
    else:
        raise ValueError('CSV 경로나 dry-run 옵션을 입력해주세요.')

    summary = summarize_metrics(shots)
    evaluation = evaluate_pass_fail(args.club, summary)

    report_path = generate_report(args.club, shots, summary, evaluation, args.output_prefix)
    plot_path = make_plots(shots, summary, args.output_prefix)

    print('분석 완료')
    print('리포트 파일: ', report_path)
    print('그래프 파일: ', plot_path)
    print('최종 판정: ', 'Pass' if evaluation['final_pass'] else 'Fail')


if __name__ == '__main__':
    main()
