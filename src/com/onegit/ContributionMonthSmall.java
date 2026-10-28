package com.onegit;

/**
 * The big-squares month widget in a 2x2. Same drawing as the larger one - only
 * the layout differs (month and total share a line) and the squares are packed
 * tighter, since a 2x2 has far less room to give them.
 */
public class ContributionMonthSmall extends ContributionMonth {

    { cell = 40; gap = 4; shortMonth = true; }

    @Override
    protected int layoutId() { return R.layout.widget_contrib_month_small; }
}
